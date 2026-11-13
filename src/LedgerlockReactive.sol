// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib-omni/base/AbstractReactive.sol";
import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";
import {CronTopics} from "reactive-kit/CronTopics.sol";
import {CallbackFailureWatch} from "reactive-kit/CallbackFailureWatch.sol";

/// @title LedgerlockReactive
/// @notice Pause-first bridge guard on Reactive Lasna. For each guarded route it reads both sides of the bridge itself
///         (lock/release on the source chain, mint/burn on the destination chain) and keeps a dual ledger. A mint (or a
///         release) it cannot match pauses BOTH gates from the same `react()`: two callbacks to two chains. If the matching
///         lock (or burn) arrives within the route's window W, the gates reopen on their own. A forged, replayed or late
///         transfer latches an incident instead, and only the owner's `resolve()` reopens the route.
/// @dev Timer-free decision: ordering is by arrival on Lasna (`block.timestamp` of this chain only); no origin-chain
///      timestamp is ever compared. A runtime Cron10 subscription exists only while a gate ack is outstanding (the ack
///      watchdog), and is dropped when the last ack lands.
///      Modes: NONCE (the bridge puts a transfer key in a topic) and SUPPLY (totals only, e.g. a Hyperlane warp route:
///      any violation pauses and latches, since totals cannot name the bad transfer).
///      Adapter limits: NONCE matching needs the same amount and recipient on both sides (a fee-taking bridge needs an
///      adapter that reports the net amount on both); a missing data word decodes as 0. SUPPLY sums every log of the
///      enrolled routers (no per-domain split), so the routers must carry this route only, and a forged mint is seen
///      only once it exceeds the legit amount in flight. An event on a quiet route is never re-examined by a timer: a
///      pending entry past W latches OVERDUE on the next route event (the gates are already shut meanwhile).
contract LedgerlockReactive is AbstractReactive {
    // ------------------------------------------------------------------ types

    enum Mode {
        NONCE,
        SUPPLY
    }

    enum Side {
        LOCK,
        MINT,
        BURN,
        RELEASE,
        ACK_PAUSED,
        ACK_RESUMED,
        HELD,
        FAIL,
        SEIZED,
        DRILL
    }

    enum Cause {
        NONE,
        REPEAT, // forged key (beyond highest lock + K), replayed / consumed key, same-key copycat, lock already seen with other fields
        LATE_LOCK, // the matching lock arrived after W
        OVERDUE, // the oldest pending entry is older than W (checked lazily on the next route event)
        FLOOD, // more than MAX_PENDING unmatched entries at once
        FAILSAFE, // a PAUSE callback was not confirmed after one retry
        SUPPLY, // SUPPLY-mode invariant violated
        DRILL // labelled operator drill
    }

    enum Kind {
        NONE,
        PAUSE,
        RESUME
    }

    /// @notice Adapter config for one guarded route. `src` = the lock/release chain, `dst` = the mint/burn chain.
    struct Route {
        Mode mode;
        uint256 srcChain;
        uint256 dstChain;
        address lockSrc; // emits Locked + Released (route A: LockBox; route B: Hyperlane collateral router)
        address mintDst; // emits Minted + Burned (+ Seized on the fixture) (route B: Hyperlane synthetic router)
        uint8 keyTopic; // 1..3 (NONCE) or 0 (SUPPLY)
        uint8 amountWord; // index of the 32-byte data word holding the amount
        uint8 recipientTopic; // 1..3, or 0 = recipient not checked
        address gateSrc;
        address gateDst;
        uint32 windowSec; // W
        address drillBeacon; // 0 = none; its `Drill(routeId)` log pauses + latches DRILL
        uint32 keySlack; // K: a key above highest lock + K is implausible
    }

    struct State {
        bool paused;
        bool incident;
        Cause cause;
        uint64 epoch;
        uint32 pendingCount;
        uint32 qHead;
        uint32 copycatsSameKey;
        uint256 unbacked; // forward: minted without a matching lock (seizable)
        uint256 unbackedRel; // reverse: released without a matching burn (collateral that left)
        // SUPPLY totals
        uint256 lockedTotal;
        uint256 mintedTotal;
        uint256 burnedTotal;
        uint256 releasedTotal;
    }

    /// @dev One `(route, dir, key)` slot. dir 0 = FWD (Locked → Minted), 1 = REV (Burned → Released).
    struct Slot {
        uint256 srcAmt;
        address srcTo;
        bool srcSeen;
        bool consumed;
        uint64 pendSince; // != 0 = a live pending entry (arrival time on Lasna)
        uint256 pendAmt;
        address pendTo;
    }

    /// @dev Per (route, gate) ack bookkeeping. c 0 = gate on dst (mint side), 1 = gate on src (release side).
    struct Ack {
        bool owed;
        Kind kind;
        uint64 epoch;
        uint64 requestedAt;
        uint64 rerequestedAt; // watchdog: 0 = not re-requested yet; one re-request per request
        bool failRetried; // CallbackFailure: one retry per request
        uint64 acked; // highest epoch acked
        bytes32 originTx;
        uint256 key;
    }

    // ------------------------------------------------------------------ constants

    uint256 internal constant PAUSED_T0 = uint256(keccak256("Paused(uint256,uint64,bytes32,uint256)"));
    uint256 internal constant RESUMED_T0 = uint256(keccak256("Resumed(uint256,uint64,bytes32,uint256)"));
    uint256 internal constant HELD_T0 = uint256(keccak256("HeldByGuardian(uint256,uint64)"));
    bytes4 internal constant PAUSE_SEL = bytes4(keccak256("pause(address,uint256,uint64,bytes32,uint256)"));
    bytes4 internal constant RESUME_SEL = bytes4(keccak256("resume(address,uint256,uint64,bytes32,uint256)"));
    uint64 internal constant CALLBACK_GAS = 1_000_000;
    uint32 public constant MAX_PENDING = 32;
    uint8 internal constant FWD = 0;
    uint8 internal constant REV = 1;

    // ------------------------------------------------------------------ storage

    address public immutable owner;
    uint32 public ackDeadline = 30; // seconds before one re-request, and again before GateUnreachable
    uint256 public routeCount;
    uint32 public outstandingAcks;
    bool public cronOn;

    mapping(uint256 => Route) internal routes;
    mapping(uint256 => State) internal states;
    mapping(uint256 => mapping(uint8 => mapping(uint256 => Slot))) public slots;
    mapping(uint256 => mapping(uint8 => uint256)) public highestSrc;
    mapping(uint256 => mapping(uint64 => mapping(address => uint256))) internal unbackedOf; // route => era => holder
    mapping(uint256 => uint64) public deficitEra; // bumped when a deficit is accepted: older per-holder figures stop counting
    mapping(uint256 => uint256[]) internal pendingQ; // packed (dir << 128) | key, oldest first
    mapping(uint256 => mapping(uint8 => Ack)) public acks;
    mapping(bytes32 => uint256) internal dispatch; // keccak(chainId, emitter, topic0) => (routeId << 8) | (side + 1)
    mapping(uint256 => mapping(address => uint256)) public gateToRoute; // chainId => gate => routeId * 2 + c
    mapping(uint256 => address) public proxyOf; // chainId => callback proxy (emits CallbackFailure)
    mapping(bytes32 => bool) public seen; // keccak(chainId, txHash, logIndex)

    // ------------------------------------------------------------------ events

    event RouteAdded(uint256 indexed routeId, Mode mode, uint256 srcChain, uint256 dstChain);
    event Observed(uint256 indexed routeId, Side side, uint256 key, bytes32 indexed originTx);
    event Mismatch(
        uint256 indexed routeId,
        Side side,
        uint256 key,
        uint256 amount,
        address to,
        bytes32 indexed originTx,
        uint64 epoch
    );
    event Matched(uint256 indexed routeId, uint256 key, bytes32 indexed originTx, uint32 waitedSec);
    event IncidentLatched(uint256 indexed routeId, Cause cause, uint64 epoch);
    event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event ResumeRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event AckSeen(uint256 indexed routeId, uint256 chainId, Side side, uint64 epoch);
    event Retried(uint256 indexed routeId, uint256 chainId, uint64 epoch);
    event GateUnreachable(uint256 indexed routeId, uint256 chainId, uint64 epoch);
    event Resolved(
        uint256 indexed routeId, uint8 reason, uint256 unbacked, uint256 unbackedRel, bool deficitAccepted, uint64 epoch
    );
    event Remediated(uint256 indexed routeId, uint256 amount, bytes32 indexed originTx);
    event CronWatch(bool on);

    error NotOwner();
    error Deficit(uint256 unbacked, uint256 unbackedRel);
    error BadRoute();
    error ProxyUnset(uint256 chainId);
    error ProxySet(uint256 chainId);

    constructor() payable {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------------ owner config

    /// @notice Register the callback proxy of a destination chain (its `CallbackFailure` log is watched per gate).
    ///         Set once per chain: the failure watch is subscribed to this proxy when a gate is bound, so a later change
    ///         would silently orphan it (a wrong proxy = redeploy).
    function setProxy(uint256 chainId, address proxy) external onlyOwner {
        if (proxyOf[chainId] != address(0)) revert ProxySet(chainId);
        proxyOf[chainId] = proxy;
    }

    function setAckDeadline(uint32 secs) external onlyOwner {
        ackDeadline = secs;
    }

    /// @notice Arm a route before its first transfer. `t0s` = topic0 of [Locked, Minted, Burned, Released, Seized, Drill]
    ///         (0 = not subscribed). Also subscribes each gate's Paused/Resumed/HeldByGuardian and the chain's callback
    ///         proxy's CallbackFailure filtered on that gate (`setProxy` first, else `ProxyUnset`).
    function addRoute(Route calldata rt, uint256[6] calldata t0s) external onlyOwner returns (uint256 r) {
        if (rt.gateSrc == address(0) || rt.gateDst == address(0) || rt.windowSec == 0) revert BadRoute();
        if (rt.mode == Mode.NONCE && (rt.keyTopic == 0 || rt.keyTopic > 3)) revert BadRoute();
        r = ++routeCount;
        routes[r] = rt;
        _bind(r, rt.srcChain, rt.lockSrc, t0s[0], Side.LOCK);
        _bind(r, rt.dstChain, rt.mintDst, t0s[1], Side.MINT);
        _bind(r, rt.dstChain, rt.mintDst, t0s[2], Side.BURN);
        _bind(r, rt.srcChain, rt.lockSrc, t0s[3], Side.RELEASE);
        _bind(r, rt.dstChain, rt.mintDst, t0s[4], Side.SEIZED);
        if (rt.drillBeacon != address(0)) _bind(r, rt.srcChain, rt.drillBeacon, t0s[5], Side.DRILL);
        _bindGate(r, rt.dstChain, rt.gateDst, 0);
        _bindGate(r, rt.srcChain, rt.gateSrc, 1);
        emit RouteAdded(r, rt.mode, rt.srcChain, rt.dstChain);
    }

    function _bind(uint256 r, uint256 chainId, address emitter, uint256 t0, Side side) internal {
        if (t0 == 0) return;
        bytes32 k = keccak256(abi.encode(chainId, emitter, t0));
        if (dispatch[k] != 0) revert BadRoute(); // one (chain, emitter, topic0) feeds exactly one route side
        dispatch[k] = (r << 8) | (uint256(side) + 1);
        SYSTEM.subscribe(chainId, emitter, t0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _bindGate(uint256 r, uint256 chainId, address gate, uint256 c) internal {
        if (gateToRoute[chainId][gate] != 0) revert BadRoute(); // a gate serves one side of one route
        gateToRoute[chainId][gate] = r * 2 + c;
        _bind(r, chainId, gate, PAUSED_T0, Side.ACK_PAUSED);
        _bind(r, chainId, gate, RESUMED_T0, Side.ACK_RESUMED);
        _bind(r, chainId, gate, HELD_T0, Side.HELD);
        address proxy = proxyOf[chainId];
        if (proxy == address(0)) revert ProxyUnset(chainId); // a gate without its failure watch would retry only via Cron
        SYSTEM.subscribe(
            chainId, proxy, CallbackFailureWatch.TOPIC, uint256(uint160(gate)), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
    }

    // ------------------------------------------------------------------ the decision

    function react(LogRecord calldata log_) external onlySystem {
        if (CronTopics.isCron(log_.contractAddress, log_.topic0)) {
            _onCron();
            return;
        }
        bytes32 logId = keccak256(abi.encode(log_.chainId, log_.txHash, log_.logIndex));
        if (seen[logId]) return; // duplicate delivery = no-op
        seen[logId] = true;
        bytes32 originTx = bytes32(log_.txHash);

        if (log_.topic0 == CallbackFailureWatch.TOPIC) {
            _onFailure(log_, originTx);
            return;
        }
        uint256 d = dispatch[keccak256(abi.encode(log_.chainId, log_.contractAddress, log_.topic0))];
        if (d == 0) return;
        uint256 r = d >> 8;
        Side side = Side(uint8(d & 0xff) - 1);
        Route storage rt = routes[r];

        if (side <= Side.RELEASE) {
            (uint256 key, address to, uint256 amt) = _fields(rt, log_);
            emit Observed(r, side, key, originTx);
            if (rt.mode == Mode.SUPPLY) {
                _onSupply(r, side, amt, to, originTx);
            } else if (side == Side.LOCK || side == Side.BURN) {
                _onSrc(r, side == Side.LOCK ? FWD : REV, key, to, amt, originTx);
            } else {
                _onDst(r, side, key, to, amt, originTx);
            }
            if (rt.mode == Mode.NONCE) _checkOverdue(r);
        } else if (side == Side.SEIZED) {
            emit Observed(r, side, 0, originTx);
            _onSeized(r, address(uint160(log_.topic1)), _word(log_.data, 0), originTx);
        } else if (side == Side.DRILL) {
            if (log_.topic1 != r) return; // a beacon fires for one route id
            emit Observed(r, side, 0, originTx);
            _pauseBoth(r, originTx, 0);
            _latch(r, Cause.DRILL);
        } else {
            // gate ack: Paused/Resumed(routeId, epoch, originTx, key) or HeldByGuardian(routeId, epoch); epoch = data word 0
            if (log_.topic1 != r) return; // the gate's indexed routeId must name the route this gate is bound to
            uint64 e = uint64(_word(log_.data, 0));
            uint256 c = gateToRoute[log_.chainId][log_.contractAddress] & 1;
            emit Observed(r, side, e, originTx);
            _onAck(r, c, side, e);
        }
        _ackDeadline(r);
    }

    function _fields(Route storage rt, LogRecord calldata l)
        internal
        view
        returns (uint256 key, address to, uint256 amt)
    {
        key = _topic(l, rt.keyTopic);
        to = rt.recipientTopic == 0 ? address(0) : address(uint160(_topic(l, rt.recipientTopic)));
        amt = _word(l.data, rt.amountWord);
    }

    function _topic(LogRecord calldata l, uint8 i) internal pure returns (uint256) {
        if (i == 1) return l.topic1;
        if (i == 2) return l.topic2;
        if (i == 3) return l.topic3;
        return 0;
    }

    function _word(bytes calldata data, uint256 i) internal pure returns (uint256) {
        if (data.length < 32 * (i + 1)) return 0;
        return uint256(bytes32(data[32 * i:32 * (i + 1)]));
    }

    /// @dev Locked (FWD) or Burned (REV): record the source side; clear a waiting entry it matches.
    function _onSrc(uint256 r, uint8 dir, uint256 key, address to, uint256 amt, bytes32 originTx) internal {
        State storage st = states[r];
        Slot storage s = slots[r][dir][key];
        s.srcAmt = amt;
        s.srcTo = to;
        s.srcSeen = true;
        if (key > highestSrc[r][dir]) highestSrc[r][dir] = key;
        if (s.pendSince == 0) return;
        if (s.pendAmt != amt || s.pendTo != to) {
            _latch(r, Cause.REPEAT); // the waiting mint carries other fields than its own lock: forged, latch now
            return;
        }

        uint256 waited = block.timestamp - s.pendSince;
        bool late = waited > routes[r].windowSec;
        s.pendAmt = 0;
        s.pendTo = address(0);
        s.pendSince = 0;
        s.consumed = true;
        if (--st.pendingCount == 0) st.qHead = uint32(pendingQ[r].length); // nothing live: skip every cleared entry
        if (dir == FWD) {
            mapping(address => uint256) storage held = unbackedOf[r][deficitEra[r]];
            uint256 dd = _min3(amt, held[to], st.unbacked);
            held[to] -= dd;
            st.unbacked -= dd;
        } else {
            st.unbackedRel -= amt < st.unbackedRel ? amt : st.unbackedRel;
        }
        if (late) {
            _latch(r, Cause.LATE_LOCK);
        } else if (!st.incident) {
            emit Matched(r, key, originTx, uint32(waited));
        }
        if (st.pendingCount == 0 && !st.incident && st.paused) _resumeBoth(r, originTx, key);
    }

    /// @dev Minted (FWD) or Released (REV): a matching source record means the normal path (no callback); anything else
    ///      pauses in this react() and waits (plausible) or latches (implausible).
    function _onDst(uint256 r, Side side, uint256 key, address to, uint256 amt, bytes32 originTx) internal {
        uint8 dir = side == Side.MINT ? FWD : REV;
        State storage st = states[r];
        Slot storage s = slots[r][dir][key];
        if (s.srcSeen && !s.consumed && s.srcAmt == amt && s.srcTo == to && s.pendSince == 0) {
            s.consumed = true;
            return;
        }
        uint256 hs = highestSrc[r][dir];
        bool implausible = (key > hs && key - hs > routes[r].keySlack) || s.consumed || s.pendSince != 0 || s.srcSeen;
        if (_addUnbacked(r, dir, to, amt)) implausible = true; // an amount that does not fit latches
        _pauseBoth(r, originTx, key); // two callbacks in THIS react() (no-op if already paused)
        emit Mismatch(r, side, key, amt, to, originTx, st.epoch);
        if (implausible) _latch(r, Cause.REPEAT);
        if (s.pendSince != 0) {
            st.copycatsSameKey++;
        } else if (key > type(uint128).max) {
            _latch(r, Cause.REPEAT); // cannot be queued (packed as dir << 128 | key); no bridge nonce is this large
        } else if (st.pendingCount < MAX_PENDING) {
            s.pendAmt = amt;
            s.pendTo = to;
            s.pendSince = uint64(block.timestamp);
            pendingQ[r].push((uint256(dir) << 128) | key);
            st.pendingCount++;
        } else {
            _latch(r, Cause.FLOOD);
        }
    }

    function _addUnbacked(uint256 r, uint8 dir, address to, uint256 amt) internal returns (bool ov) {
        State storage st = states[r];
        if (dir == FWD) {
            bool ovH;
            mapping(address => uint256) storage held = unbackedOf[r][deficitEra[r]];
            (st.unbacked, ov) = _sadd(st.unbacked, amt);
            (held[to], ovH) = _sadd(held[to], amt);
            ov = ov || ovH;
        } else {
            (st.unbackedRel, ov) = _sadd(st.unbackedRel, amt);
        }
    }

    /// @dev Lazy, timer-free OVERDUE: after the side handler, the oldest live pending entry older than W latches.
    function _checkOverdue(uint256 r) internal {
        State storage st = states[r];
        uint256[] storage q = pendingQ[r];
        if (st.pendingCount == 0) {
            st.qHead = uint32(q.length);
            return;
        }
        uint256 h = st.qHead;
        Slot storage s;
        while (h < q.length) {
            s = slots[r][uint8(q[h] >> 128)][uint128(q[h])];
            if (s.pendSince != 0) {
                if (block.timestamp - s.pendSince > routes[r].windowSec) _latch(r, Cause.OVERDUE);
                break;
            }
            h++;
        }
        st.qHead = uint32(h);
    }

    function _onSupply(uint256 r, Side side, uint256 amt, address to, bytes32 originTx) internal {
        State storage st = states[r];
        bool bad; // a total that does not fit is itself a violation (a saturated total would blind the invariant)
        if (side == Side.LOCK) {
            (st.lockedTotal, bad) = _sadd(st.lockedTotal, amt);
        } else if (side == Side.MINT) {
            (st.mintedTotal, bad) = _sadd(st.mintedTotal, amt);
            bad = bad || st.mintedTotal > st.lockedTotal;
        } else if (side == Side.BURN) {
            (st.burnedTotal, bad) = _sadd(st.burnedTotal, amt);
        } else {
            (st.releasedTotal, bad) = _sadd(st.releasedTotal, amt);
            bad = bad || st.releasedTotal > st.burnedTotal;
        }
        if (!bad) return;
        _pauseBoth(r, originTx, 0);
        emit Mismatch(r, side, 0, amt, to, originTx, st.epoch);
        _latch(r, Cause.SUPPLY);
    }

    function _onSeized(uint256 r, address holder, uint256 amt, bytes32 originTx) internal {
        State storage st = states[r];
        mapping(address => uint256) storage held = unbackedOf[r][deficitEra[r]];
        uint256 dd = _min3(amt, held[holder], st.unbacked);
        held[holder] -= dd;
        st.unbacked -= dd;
        emit Remediated(r, dd, originTx);
    }

    function _latch(uint256 r, Cause cause) internal {
        State storage st = states[r];
        if (st.incident) return;
        st.incident = true;
        st.cause = cause;
        emit IncidentLatched(r, cause, st.epoch);
    }

    // ------------------------------------------------------------------ callbacks, acks, retries

    function _pauseBoth(uint256 r, bytes32 originTx, uint256 key) internal {
        State storage st = states[r];
        if (st.paused && !_exhausted(r)) return; // copycats never re-bill a pause that is confirmed or still in flight
        // First pause, or a pause leg that went GateUnreachable: a NEW epoch to both gates, so a late failure of the
        // exhausted cycle (older epoch) can never spend the new cycle's retry budget.
        st.paused = true;
        uint64 e = ++st.epoch;
        emit PauseRequested(r, e, originTx, key);
        _request(r, 0, Kind.PAUSE, e, originTx, key); // mint side first: it stops further issuance
        _request(r, 1, Kind.PAUSE, e, originTx, key); // release side: freezes collateral exits
    }

    function _resumeBoth(uint256 r, bytes32 originTx, uint256 key) internal {
        State storage st = states[r];
        st.paused = false;
        uint64 e = ++st.epoch;
        emit ResumeRequested(r, e, originTx, key);
        _request(r, 0, Kind.RESUME, e, originTx, key);
        _request(r, 1, Kind.RESUME, e, originTx, key);
    }

    function _request(uint256 r, uint256 c, Kind kind, uint64 e, bytes32 originTx, uint256 key) internal {
        Ack storage a = acks[r][uint8(c)];
        if (!a.owed) {
            a.owed = true; // a newer epoch supersedes whatever was still owed on this gate
            outstandingAcks++;
        }
        a.kind = kind;
        a.epoch = e;
        a.originTx = originTx;
        a.key = key;
        a.requestedAt = uint64(block.timestamp);
        a.rerequestedAt = 0;
        a.failRetried = false;
        if (!cronOn) {
            cronOn = true;
            SYSTEM.subscribe(
                block.chainid,
                CronTopics.LEGACY_SYSTEM_ADDR,
                CronTopics.CRON10,
                REACTIVE_IGNORE,
                REACTIVE_IGNORE,
                REACTIVE_IGNORE
            );
            emit CronWatch(true);
        }
        _send(r, c);
    }

    /// @dev (Re)build the exact callback from the stored request, so a retry carries the same epoch and origin tx.
    function _send(uint256 r, uint256 c) internal {
        Ack storage a = acks[r][uint8(c)];
        Route storage rt = routes[r];
        bytes memory payload = abi.encodeWithSelector(
            a.kind == Kind.PAUSE ? PAUSE_SEL : RESUME_SEL, address(0), r, a.epoch, a.originTx, a.key
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: c == 0 ? rt.dstChain : rt.srcChain,
                recipient: c == 0 ? rt.gateDst : rt.gateSrc,
                gasLimit: CALLBACK_GAS,
                payload: payload
            })
        );
    }

    function _settle(Ack storage a) internal {
        if (!a.owed) return;
        a.owed = false;
        outstandingAcks--;
        if (outstandingAcks == 0 && cronOn) {
            cronOn = false;
            SYSTEM.unsubscribe(
                block.chainid,
                CronTopics.LEGACY_SYSTEM_ADDR,
                CronTopics.CRON10,
                REACTIVE_IGNORE,
                REACTIVE_IGNORE,
                REACTIVE_IGNORE
            );
            emit CronWatch(false);
        }
    }

    function _onAck(uint256 r, uint256 c, Side side, uint64 e) internal {
        Ack storage a = acks[r][uint8(c)];
        if (e > a.acked) a.acked = e;
        emit AckSeen(r, _chainOf(r, c), side, e);
        if (a.owed && e == a.epoch) _settle(a); // a held gate answers a RESUME with HeldByGuardian: settled, no latch
    }

    /// @dev The proxy's CallbackFailure(target, payload): the payload is the full callback calldata with the requesting
    ///      RSC in word 0 (measured on both proxies), so the epoch is argument word 2. Obsolete failures are ignored.
    function _onFailure(LogRecord calldata l, bytes32 originTx) internal {
        if (l.contractAddress != proxyOf[l.chainId]) return;
        uint256 g = gateToRoute[l.chainId][address(uint160(l.topic1))];
        if (g == 0) return;
        uint256 r = g >> 1;
        uint256 c = g & 1;
        bytes memory p = abi.decode(l.data, (bytes));
        uint64 fEpoch = p.length >= 4 + 32 * 3 ? uint64(CallbackFailureWatch.argWord(p, 2)) : 0;
        emit Observed(r, Side.FAIL, fEpoch, originTx);
        Ack storage a = acks[r][uint8(c)];
        if (!a.owed || fEpoch != a.epoch) return; // obsolete (older epoch) or already settled
        // Any reactive contract can make the proxy fail a callback to our gate (the gate rejects its RVM id), so the
        // failure counts only if the proxy-injected requester is this contract and the call is our current request.
        if (
            bytes4(p) != (a.kind == Kind.PAUSE ? PAUSE_SEL : RESUME_SEL)
                || CallbackFailureWatch.argWord(p, 0) != uint256(uint160(address(this)))
                || CallbackFailureWatch.argWord(p, 1) != r
        ) return;
        if (!a.failRetried) {
            a.failRetried = true;
            a.requestedAt = uint64(block.timestamp); // the watchdog now waits a full deadline for the retry
            if (a.rerequestedAt != 0) a.rerequestedAt = uint64(block.timestamp);
            _send(r, c);
            emit Retried(r, _chainOf(r, c), fEpoch);
        } else {
            _unreachable(r, c);
        }
    }

    /// @dev Ack watchdog: one re-request after `ackDeadline`, then GateUnreachable (+ FAILSAFE latch for a PAUSE; a
    ///      stuck RESUME leaves that gate shut and does not latch). Budget per request: at most two re-sends, one on the
    ///      watchdog deadline and one on a matching CallbackFailure, then GateUnreachable. After that the next mismatch
    ///      (`_pauseBoth`) or the owner's next `resolve()` opens a new epoch to both gates; that new request supersedes
    ///      the other gate's in-flight one too (its budget restarts with the new epoch).
    function _ackDeadline(uint256 r) internal {
        for (uint256 c; c < 2; c++) {
            Ack storage a = acks[r][uint8(c)];
            if (!a.owed) continue;
            if (a.rerequestedAt == 0) {
                if (block.timestamp - a.requestedAt > ackDeadline) {
                    a.rerequestedAt = uint64(block.timestamp);
                    _send(r, c);
                    emit Retried(r, _chainOf(r, c), a.epoch);
                }
            } else if (block.timestamp - a.rerequestedAt > ackDeadline) {
                _unreachable(r, c);
            }
        }
    }

    function _unreachable(uint256 r, uint256 c) internal {
        Ack storage a = acks[r][uint8(c)];
        Kind kind = a.kind;
        uint64 e = a.epoch;
        _settle(a);
        emit GateUnreachable(r, _chainOf(r, c), e);
        if (kind == Kind.PAUSE) _latch(r, Cause.FAILSAFE);
    }

    function _onCron() internal {
        uint256 n = routeCount;
        for (uint256 r = 1; r <= n; r++) {
            if (acks[r][0].owed || acks[r][1].owed) _ackDeadline(r);
        }
    }

    function _chainOf(uint256 r, uint256 c) internal view returns (uint256) {
        return c == 0 ? routes[r].dstChain : routes[r].srcChain;
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
        m = a < b ? a : b;
        if (c < m) m = c;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Reopen a latched or paused route. Reverts while a deficit is outstanding unless `acceptDeficit`, so
    ///         reopening never hides unbacked supply. Every live pending entry is marked consumed (a later replay of that
    ///         key is unmatched). A plain external method requesting the two resume callbacks.
    function resolve(uint256 r, uint8 reason, bool acceptDeficit) external onlyOwner {
        if (r == 0 || r > routeCount) revert BadRoute();
        State storage st = states[r];
        (uint256 def, uint256 defRel) = _deficit(r);
        if ((def != 0 || defRel != 0) && !acceptDeficit) revert Deficit(def, defRel); // no add: a side may be saturated
        uint256[] storage q = pendingQ[r];
        for (uint256 h = st.qHead; h < q.length; h++) {
            Slot storage s = slots[r][uint8(q[h] >> 128)][uint128(q[h])];
            if (s.pendSince != 0) {
                s.pendAmt = 0;
                s.pendTo = address(0);
                s.pendSince = 0;
                s.consumed = true;
            }
        }
        st.qHead = uint32(q.length);
        st.pendingCount = 0;
        st.incident = false;
        st.cause = Cause.NONE;
        if (acceptDeficit) {
            deficitEra[r]++; // a stale holder's later seize can no longer offset a new attack's deficit
            st.unbacked = 0;
            st.unbackedRel = 0;
            // lift the source side to the destination side; a saturated source total (blind invariant) is rebased too
            uint256 max = type(uint256).max;
            if (st.mintedTotal > st.lockedTotal || st.lockedTotal == max) st.lockedTotal = st.mintedTotal;
            if (st.releasedTotal > st.burnedTotal || st.burnedTotal == max) st.burnedTotal = st.releasedTotal;
        }
        // paused → reopen; already reopened but a RESUME went GateUnreachable (that gate is still shut) → a new resume epoch
        bool reopen = st.paused || _exhausted(r);
        emit Resolved(r, reason, def, defRel, acceptDeficit, reopen ? st.epoch + 1 : st.epoch);
        if (reopen) _resumeBoth(r, bytes32(0), 0);
    }

    /// @dev A gate whose request for the current epoch was never confirmed and is no longer owed (GateUnreachable).
    function _exhausted(uint256 r) internal view returns (bool) {
        uint64 e = states[r].epoch;
        for (uint256 c; c < 2; c++) {
            Ack storage a = acks[r][uint8(c)];
            if (!a.owed && a.acked < e) return true;
        }
        return false;
    }

    /// @dev Saturating add: an amount that does not fit must not revert react() before the pause (a revert = no pause).
    function _sadd(uint256 a, uint256 b) internal pure returns (uint256 sum, bool ov) {
        unchecked {
            sum = a + b;
        }
        ov = sum < a;
        if (ov) sum = type(uint256).max;
    }

    function _deficit(uint256 r) internal view returns (uint256 def, uint256 defRel) {
        State storage st = states[r];
        if (routes[r].mode == Mode.SUPPLY) {
            uint256 max = type(uint256).max; // a saturated source total hides any deficit: it counts as one
            def = st.lockedTotal == max ? max : st.mintedTotal > st.lockedTotal ? st.mintedTotal - st.lockedTotal : 0;
            defRel = st.burnedTotal == max ? max : st.releasedTotal > st.burnedTotal ? st.releasedTotal - st.burnedTotal : 0;
        } else {
            (def, defRel) = (st.unbacked, st.unbackedRel);
        }
    }

    /// @notice Return unspent lREACT to the owner (dev deployments are torn down after their runs).
    function drain() external onlyOwner {
        (bool ok,) = payable(owner).call{value: address(this).balance}("");
        require(ok, "drain");
    }

    // ------------------------------------------------------------------ views

    function routeState(uint256 r)
        external
        view
        returns (
            bool paused,
            bool incident,
            bool overdue,
            uint64 epoch,
            uint32 pending,
            uint256 unbacked,
            uint256 unbackedRel
        )
    {
        State storage st = states[r];
        (unbacked, unbackedRel) = _deficit(r);
        paused = st.paused;
        incident = st.incident;
        epoch = st.epoch;
        pending = st.pendingCount;
        uint256[] storage q = pendingQ[r];
        for (uint256 h = st.qHead; h < q.length; h++) {
            Slot storage s = slots[r][uint8(q[h] >> 128)][uint128(q[h])];
            if (s.pendSince != 0) {
                overdue = block.timestamp - s.pendSince > routes[r].windowSec;
                break;
            }
        }
    }

    /// @notice Unbacked amount minted to `holder` on route `r` in the current deficit era (what a seize can remediate).
    function holderUnbacked(uint256 r, address holder) external view returns (uint256) {
        return unbackedOf[r][deficitEra[r]][holder];
    }

    function getRoute(uint256 r) external view returns (Route memory) {
        return routes[r];
    }

    function getState(uint256 r) external view returns (State memory) {
        return states[r];
    }

    function pendingQueue(uint256 r) external view returns (uint256[] memory) {
        return pendingQ[r];
    }
}
