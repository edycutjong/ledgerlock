// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib-omni/base/AbstractReactive.sol";
import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";
import {CronTopics} from "reactive-kit/CronTopics.sol";

/// @title LedgerlockReactive (spike v0, one route, NONCE mode)
/// @notice Pause-first bridge guard on Reactive Lasna. It reads both sides of a lock-and-mint route itself:
///         `Locked` on the source chain, `Minted` on the destination chain. A mint whose lock it has not seen pauses
///         BOTH gates from the same `react()` (two callbacks to two chains); the matching lock arriving later
///         resumes them. A lock or a matched mint costs no callback.
/// @dev Spike scope (gate G1 + first live triples): one route, auto-resume on the matching lock, owner `resolve`.
///      The incident latch, window W, recipient-bound keys, `(r, dir, key)` namespace, retries and the release
///      direction come with the core flow. Probe hooks: `probeHop` (self-callback to Lasna) and a one-shot runtime
///      Cron subscribe/unsubscribe from `react()` (`armCronProbe`).
contract LedgerlockReactive is AbstractReactive {
    uint256 internal constant LOCKED_T0 = uint256(keccak256("Locked(uint64,address,uint256)"));
    uint256 internal constant MINTED_T0 = uint256(keccak256("Minted(uint64,address,uint256)"));
    uint256 internal constant PAUSED_T0 = uint256(keccak256("Paused(uint256,uint64,bytes32,uint256)"));
    uint256 internal constant RESUMED_T0 = uint256(keccak256("Resumed(uint256,uint64,bytes32,uint256)"));
    uint64 internal constant CALLBACK_GAS = 1_000_000;
    uint64 internal constant HOP_GAS = 300_000;
    uint256 public constant ROUTE_ID = 1;

    enum Side {
        LOCK,
        MINT,
        ACK_PAUSED,
        ACK_RESUMED
    }

    address public immutable owner;

    // route config (set once by `init`)
    uint256 public srcChain;
    uint256 public dstChain;
    address public lockBox;
    address public minter;
    address public gateSrc;
    address public gateDst;
    bool public initialized;

    // dual ledger (spike)
    mapping(uint256 => uint256) public lockAmt;
    mapping(uint256 => address) public lockTo;
    mapping(uint256 => bool) public minted;
    mapping(uint256 => uint256) public pendingAmt;
    mapping(uint256 => address) public pendingTo;
    mapping(uint256 => uint256) public pendingSince;
    uint256 public pendingCount;
    uint256 public unbacked;

    bool public paused;
    uint64 public epoch;
    mapping(bytes32 => bool) public seen;

    // probes
    uint8 public cronProbe; // 0 off, 1 armed, 2 subscribed, 3 done
    uint256 public hopSeq;

    event Observed(uint256 indexed routeId, Side side, uint256 key, bytes32 indexed originTx);
    event Mismatch(uint256 indexed routeId, uint256 key, uint256 amount, address to, bytes32 indexed originTx, uint64 epoch);
    event Matched(uint256 indexed routeId, uint256 key, bytes32 indexed originTx, uint32 waitedSec);
    event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event ResumeRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event AckSeen(uint256 indexed routeId, uint256 chainId, bool pausedAck, uint64 epoch, bytes32 indexed originTx);
    event Resolved(uint256 indexed routeId, uint256 cleared, uint256 unbacked, uint64 epoch);
    event HopRequested(uint256 indexed seq);
    event HopSeen(uint256 indexed seq, address sender, address rvm, bool authorised);
    event CronProbe(uint8 stage, uint256 at);

    error NotOwner();
    error AlreadyInitialized();

    constructor() payable {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }


    /// @notice Wire the route and subscribe: Locked (source), Minted (destination), Paused/Resumed acks on both gates.
    function init(uint256 srcChain_, address lockBox_, address gateSrc_, uint256 dstChain_, address minter_, address gateDst_)
        external
        onlyOwner
    {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        (srcChain, lockBox, gateSrc, dstChain, minter, gateDst) = (srcChain_, lockBox_, gateSrc_, dstChain_, minter_, gateDst_);
        epoch = 1;
        _sub(srcChain_, lockBox_, LOCKED_T0);
        _sub(dstChain_, minter_, MINTED_T0);
        _sub(srcChain_, gateSrc_, PAUSED_T0);
        _sub(srcChain_, gateSrc_, RESUMED_T0);
        _sub(dstChain_, gateDst_, PAUSED_T0);
        _sub(dstChain_, gateDst_, RESUMED_T0);
    }

    function _sub(uint256 chainId, address c, uint256 t0) internal {
        SYSTEM.subscribe(chainId, c, t0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
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

        if (log_.chainId == srcChain && log_.contractAddress == lockBox && log_.topic0 == LOCKED_T0) {
            emit Observed(ROUTE_ID, Side.LOCK, log_.topic1, originTx);
            _onLocked(log_.topic1, address(uint160(log_.topic2)), abi.decode(log_.data, (uint256)), originTx);
        } else if (log_.chainId == dstChain && log_.contractAddress == minter && log_.topic0 == MINTED_T0) {
            emit Observed(ROUTE_ID, Side.MINT, log_.topic1, originTx);
            _onMinted(log_.topic1, address(uint160(log_.topic2)), abi.decode(log_.data, (uint256)), originTx);
        } else if (log_.topic0 == PAUSED_T0 || log_.topic0 == RESUMED_T0) {
            bool isPause = log_.topic0 == PAUSED_T0;
            if (
                !((log_.chainId == srcChain && log_.contractAddress == gateSrc)
                        || (log_.chainId == dstChain && log_.contractAddress == gateDst))
            ) return;
            (uint64 e,) = abi.decode(log_.data, (uint64, uint256));
            emit Observed(ROUTE_ID, isPause ? Side.ACK_PAUSED : Side.ACK_RESUMED, 0, originTx);
            emit AckSeen(ROUTE_ID, log_.chainId, isPause, e, bytes32(log_.topic2));
            if (cronProbe == 1) {
                cronProbe = 2;
                SYSTEM.subscribe(
                    block.chainid, CronTopics.LEGACY_SYSTEM_ADDR, CronTopics.CRON10, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
                );
                emit CronProbe(2, block.timestamp);
            }
        }
    }

    function _onLocked(uint256 key, address to, uint256 amt, bytes32 originTx) internal {
        lockAmt[key] = amt;
        lockTo[key] = to;
        if (pendingAmt[key] != 0 && pendingAmt[key] == amt && pendingTo[key] == to) {
            uint32 waited = uint32(block.timestamp - pendingSince[key]);
            delete pendingAmt[key];
            delete pendingTo[key];
            delete pendingSince[key];
            pendingCount--;
            minted[key] = true;
            unbacked -= amt;
            emit Matched(ROUTE_ID, key, originTx, waited);
            if (pendingCount == 0 && paused) _resumeBoth(originTx, key);
        }
    }

    function _onMinted(uint256 key, address to, uint256 amt, bytes32 originTx) internal {
        if (lockAmt[key] == amt && amt != 0 && lockTo[key] == to && !minted[key]) {
            minted[key] = true; // normal path: no callback
            emit Matched(ROUTE_ID, key, originTx, 0);
            return;
        }
        emit Mismatch(ROUTE_ID, key, amt, to, originTx, epoch);
        unbacked += amt;
        if (pendingAmt[key] == 0) {
            pendingAmt[key] = amt;
            pendingTo[key] = to;
            pendingSince[key] = block.timestamp;
            pendingCount++;
        } else {
            // a second mint on a key that is already pending: over-issuance, so the entry can no longer equal one
            // lock's amount (no auto-resume) and `resolve` clears the whole amount
            pendingAmt[key] += amt;
        }
        if (!paused) _pauseBoth(originTx, key);
    }

    // ------------------------------------------------------------------ callbacks

    function _pauseBoth(bytes32 originTx, uint256 key) internal {
        paused = true;
        uint64 e = ++epoch;
        emit PauseRequested(ROUTE_ID, e, originTx, key);
        bytes memory payload = abi.encodeWithSignature(
            "pause(address,uint256,uint64,bytes32,uint256)", address(0), ROUTE_ID, e, originTx, key
        );
        _cb(dstChain, gateDst, payload); // mint side first: it stops further issuance
        _cb(srcChain, gateSrc, payload); // release side: freezes collateral exits
    }

    function _resumeBoth(bytes32 originTx, uint256 key) internal {
        paused = false;
        uint64 e = ++epoch;
        emit ResumeRequested(ROUTE_ID, e, originTx, key);
        bytes memory payload = abi.encodeWithSignature(
            "resume(address,uint256,uint64,bytes32,uint256)", address(0), ROUTE_ID, e, originTx, key
        );
        _cb(dstChain, gateDst, payload);
        _cb(srcChain, gateSrc, payload);
    }

    function _cb(uint256 chainId, address recipient, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: chainId, recipient: recipient, gasLimit: CALLBACK_GAS, payload: payload
            })
        );
    }

    // ------------------------------------------------------------------ owner

    /// @notice Clear the listed pending mints; when nothing is left pending, reopen both gates (a plain external method
    ///         requesting callbacks). A partial resolve keeps the gates shut and requests nothing.
    function resolve(uint256[] calldata keys) external onlyOwner {
        uint256 cleared;
        for (uint256 i; i < keys.length; i++) {
            uint256 k = keys[i];
            if (pendingAmt[k] != 0) {
                unbacked -= pendingAmt[k];
                delete pendingAmt[k];
                delete pendingTo[k];
                delete pendingSince[k];
                pendingCount--;
                cleared++;
            }
        }
        bool reopen = pendingCount == 0 && paused;
        emit Resolved(ROUTE_ID, cleared, unbacked, reopen ? epoch + 1 : epoch);
        if (reopen) _resumeBoth(bytes32(0), 0);
    }

    // ------------------------------------------------------------------ probes

    /// @notice Probe: one self-callback to this contract on Lasna (the hop path's transport).
    function probeHop() external onlyOwner {
        uint256 seq = ++hopSeq;
        emit HopRequested(seq);
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: block.chainid,
                recipient: address(this),
                gasLimit: HOP_GAS,
                payload: abi.encodeWithSignature("hop(address,uint256)", address(0), seq)
            })
        );
    }

    /// @notice Self-callback target. Records who delivered it; acts only for the system sender + this contract.
    function hop(address rvm, uint256 seq) external {
        bool ok = msg.sender == address(SYSTEM) && rvm == address(this);
        emit HopSeen(seq, msg.sender, rvm, ok);
    }

    /// @notice Probe: the next gate ack subscribes Cron10 from inside `react()`; the first tick unsubscribes it.
    function armCronProbe() external onlyOwner {
        cronProbe = 1;
    }

    function _onCron() internal {
        if (cronProbe != 2) return;
        cronProbe = 3;
        SYSTEM.unsubscribe(
            block.chainid, CronTopics.LEGACY_SYSTEM_ADDR, CronTopics.CRON10, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        emit CronProbe(3, block.timestamp);
    }

    /// @notice Owner fallback if an in-react unsubscribe did not take.
    function cronStop() external onlyOwner {
        SYSTEM.unsubscribe(
            block.chainid, CronTopics.LEGACY_SYSTEM_ADDR, CronTopics.CRON10, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        cronProbe = 3;
    }

    /// @notice Return unspent lREACT to the owner (dev deployments are torn down after their runs).
    function drain() external onlyOwner {
        (bool ok,) = payable(owner).call{value: address(this).balance}("");
        require(ok, "drain");
    }
}
