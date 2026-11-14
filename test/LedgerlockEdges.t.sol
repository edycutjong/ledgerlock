// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Test.sol";
import {OmniReactiveTest} from "reactive-kit/test/OmniReactiveTest.sol";
import {CallbackResult} from "reactive-test-lib/interfaces/IReactiveInterfaces.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {LedgerlockReactive} from "../src/LedgerlockReactive.sol";
import {Gate} from "../src/Gate.sol";
import {CronTopics} from "reactive-kit/CronTopics.sol";

/// @dev An owner contract that cannot receive lREACT (no receive/fallback).
contract EthRejectingOwner {
    LedgerlockReactive public immutable rsc;

    constructor() payable {
        rsc = new LedgerlockReactive{value: msg.value}();
    }

    function drain() external {
        rsc.drain();
    }
}

/// @title Ledgerlock edge cases: adapter decoding, reverse-direction matching, saturation, owner surface.
/// @dev Same harness as LedgerlockReactive.t.sol (Omni system mock + reactive-test-lib callback proxy). Logs are fed as
///      the system contract; `deliver` goes through subscription matching, a direct `react` call skips it.
contract LedgerlockEdgesTest is OmniReactiveTest {
    uint256 constant BASE = 84532;
    uint256 constant UNI = 1301;
    uint256 constant W = 60;
    uint256 constant R = 1; // route A
    address constant PROXY_B = address(0xB0B0);
    address constant PROXY_U = address(0x0C0C);

    uint256 constant LOCKED_T0 = uint256(keccak256("Locked(uint64,address,uint256)"));
    uint256 constant MINTED_T0 = uint256(keccak256("Minted(uint64,address,uint256)"));
    uint256 constant BURNED_T0 = uint256(keccak256("Burned(uint64,address,uint256)"));
    uint256 constant RELEASED_T0 = uint256(keccak256("Released(uint64,address,uint256)"));
    uint256 constant SEIZED_T0 = uint256(keccak256("Seized(address,uint256)"));
    uint256 constant DRILL_T0 = uint256(keccak256("Drill(uint256)"));
    uint256 constant SENT_T0 = uint256(keccak256("SentTransferRemote(uint32,bytes32,uint256)"));
    uint256 constant RECV_T0 = uint256(keccak256("ReceivedTransferRemote(uint32,bytes32,uint256)"));
    uint256 constant CF_T0 = 0xc8313f695443128e273f1edfcec40b94b7deea8dfbeafd0043290d6601d999db;

    LedgerlockReactive rsc;
    Gate gateB;
    Gate gateU;
    address box = makeAddr("lockBox");
    address minter = makeAddr("minter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address thief = makeAddr("thief");
    uint256 txn;

    receive() external payable {} // the test contract is the owner: drain() pays it

    function setUp() public override {
        super.setUp();
        rsc = new LedgerlockReactive{value: 1 ether}();
        gateB = new Gate(address(proxy), address(rsc), address(this));
        gateU = new Gate(address(proxy), address(rsc), address(this));
        onChain(address(gateB), BASE);
        onChain(address(gateU), UNI);
        rsc.setProxy(BASE, PROXY_B);
        rsc.setProxy(UNI, PROXY_U);
        assertEq(rsc.addRoute(_routeA(box, minter, address(gateB), address(gateU)), _t0A()), R);
    }

    // ================================================================== owner config + views

    function test_getRoute_returns_the_armed_adapter_config() public view {
        LedgerlockReactive.Route memory rt = rsc.getRoute(R);
        assertEq(uint8(rt.mode), uint8(LedgerlockReactive.Mode.NONCE));
        assertEq(rt.srcChain, BASE);
        assertEq(rt.dstChain, UNI);
        assertEq(rt.lockSrc, box);
        assertEq(rt.mintDst, minter);
        assertEq(rt.keyTopic, 1);
        assertEq(rt.amountWord, 0);
        assertEq(rt.recipientTopic, 2);
        assertEq(rt.gateSrc, address(gateB));
        assertEq(rt.gateDst, address(gateU));
        assertEq(rt.windowSec, W);
        assertEq(rt.drillBeacon, address(0));
        assertEq(rt.keySlack, 16);
        assertEq(uint8(rsc.getRoute(R + 1).mode), 0); // unknown route: zeroed struct, no revert
        assertEq(rsc.getRoute(R + 1).gateDst, address(0));
    }

    function test_addRoute_rejects_gate_already_serving_another_route() public {
        Gate fresh = new Gate(address(proxy), address(rsc), address(this));
        // fresh emitters, but the mint-side gate already serves route A
        vm.expectRevert(LedgerlockReactive.BadRoute.selector);
        rsc.addRoute(_routeA(makeAddr("lb2"), makeAddr("mt2"), address(fresh), address(gateU)), _t0A());
        // fresh mint-side gate, but the release-side gate already serves route A
        vm.expectRevert(LedgerlockReactive.BadRoute.selector);
        rsc.addRoute(_routeA(makeAddr("lb2"), makeAddr("mt2"), address(gateB), address(fresh)), _t0A());
        assertEq(rsc.routeCount(), 1);
        assertEq(rsc.gateToRoute(BASE, address(gateB)), R * 2 + 1);
        assertEq(rsc.gateToRoute(UNI, address(gateU)), R * 2);
    }

    function test_setAckDeadline_owner_only_and_moves_the_watchdog() public {
        vm.prank(alice);
        vm.expectRevert(LedgerlockReactive.NotOwner.selector);
        rsc.setAckDeadline(1);
        assertEq(rsc.ackDeadline(), 30);

        rsc.setAckDeadline(120);
        assertEq(rsc.ackDeadline(), 120);
        uint256 t0 = vm.getBlockTimestamp();
        deliver(_M(1, alice, 1e18)); // plausible: pause epoch 1 to both gates
        sys.takeRequests(); // both requests dropped: the gates stay silent
        vm.warp(t0 + 31); // past the old 30 s default, inside the new 120 s deadline
        assertEq(cron(CronTopics.CRON10).length, 0, "no re-request before the new deadline");
        vm.warp(t0 + 121);
        CallbackResult[] memory r = cron(CronTopics.CRON10);
        assertEq(r.length, 2, "one re-request per gate after the new deadline");
        assertAllSucceeded(r);
        assertEq(rsc.outstandingAcks(), 0);
    }

    function test_drain_returns_balance_to_owner_only() public {
        vm.prank(alice);
        vm.expectRevert(LedgerlockReactive.NotOwner.selector);
        rsc.drain();
        assertEq(address(rsc).balance, 1 ether);

        uint256 before = address(this).balance;
        rsc.drain();
        assertEq(address(rsc).balance, 0);
        assertEq(address(this).balance, before + 1 ether);
    }

    function test_drain_reverts_when_owner_rejects_value() public {
        EthRejectingOwner o = new EthRejectingOwner{value: 1 ether}();
        vm.expectRevert(bytes("drain"));
        o.drain();
        assertEq(address(o.rsc()).balance, 1 ether);
    }

    // ================================================================== react() entry: logs no route claims

    function test_react_without_route_binding_is_a_noop() public {
        // e.g. a stale or wildcard subscription: the log reaches react() but maps to no (chain, emitter, topic0) side
        IReactive.LogRecord memory l = _log(UNI, address(0xDEAD), MINTED_T0, 1_000_000, uint160(thief), 500e18);
        vm.recordLogs();
        vm.prank(SYSTEM_ADDR);
        rsc.react(l);
        assertEq(vm.getRecordedLogs().length, 0, "no event");
        assertEq(sys.takeRequests().length, 0, "no callback");
        assertTrue(rsc.seen(keccak256(abi.encode(l.chainId, l.txHash, l.logIndex))), "marked seen");
        _assertOpen(R, 0);
    }

    function test_failure_for_a_gate_no_route_owns_is_ignored() public {
        deliver(_M(1, alice, 1e18)); // pause epoch 1 owed on both gates
        sys.takeRequests();
        // a CallbackFailure from the registered proxy, for a target that is not one of our gates
        bytes memory payload =
            abi.encodeWithSelector(Gate.pause.selector, address(rsc), R, uint64(1), bytes32(0), uint256(0));
        IReactive.LogRecord memory f = _log(UNI, PROXY_U, CF_T0, uint160(address(0xBEEF)), 0, 0);
        f.data = abi.encode(payload);
        vm.recordLogs();
        vm.prank(SYSTEM_ADDR); // direct: the harness would filter it out on the target topic
        rsc.react(f);
        Vm.Log[] memory emitted = vm.getRecordedLogs();
        assertEq(emitted.length, 0, "no Observed(FAIL), no Retried");
        assertEq(sys.takeRequests().length, 0, "no retry");
        (bool owed,,,,, bool failRetried,,,) = rsc.acks(R, 0);
        assertTrue(owed);
        assertFalse(failRetried, "retry budget untouched");
    }

    // ================================================================== adapter decoding

    function test_adapter_reads_key_from_topic3_and_recipient_from_topic1() public {
        // a bridge shaped like Event(address indexed to, uint32 indexed domain, uint256 indexed nonce, uint256 amount)
        Gate gb = new Gate(address(proxy), address(rsc), address(this));
        Gate gu = new Gate(address(proxy), address(rsc), address(this));
        onChain(address(gb), BASE);
        onChain(address(gu), UNI);
        address lb = makeAddr("lb3");
        address mt = makeAddr("mt3");
        LedgerlockReactive.Route memory rt = _routeA(lb, mt, address(gb), address(gu));
        rt.keyTopic = 3;
        rt.recipientTopic = 1;
        uint256 r3 = rsc.addRoute(rt, _t0A());

        assertEq(feed(_log3(BASE, lb, LOCKED_T0, uint160(alice), 7, 5, 100e18)).length, 0);
        assertEq(feed(_log3(UNI, mt, MINTED_T0, uint160(alice), 7, 5, 100e18)).length, 0, "matched on topic3 key");
        (,,, bool consumed,,,) = rsc.slots(r3, 0, 5);
        assertTrue(consumed);

        IReactive.LogRecord memory m = _log3(UNI, mt, MINTED_T0, uint160(alice), 7, 6, 100e18);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Mismatch(r3, LedgerlockReactive.Side.MINT, 6, 100e18, alice, bytes32(m.txHash), 1);
        assertEq(feed(m).length, 2, "unmatched topic3 key pauses both gates");
    }

    function test_missing_amount_word_decodes_as_zero_and_still_pauses() public {
        // a short log must never revert react() (a revert = no pause): the missing data word reads as 0
        IReactive.LogRecord memory m = _M(1, alice, 0);
        m.data = "";
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Mismatch(R, LedgerlockReactive.Side.MINT, 1, 0, alice, bytes32(m.txHash), 1);
        assertEq(feed(m).length, 2);
        (,,,, uint256 pendAmt,) = _slotOf(R, 0, 1);
        assertEq(pendAmt, 0);
        IReactive.LogRecord memory l = _L(1, alice, 0);
        l.data = hex"00ff"; // shorter than one word: also 0
        assertEq(feed(l).length, 2, "the matching lock resumes both gates");
        _assertOpen(R, 0);
    }

    // ================================================================== reverse direction (Burned -> Released)

    function test_release_before_its_burn_within_W_resumes_and_clears_unbackedRel() public {
        // the release log reaches Lasna before its burn: plausible, so the route pauses and waits (no latch)
        assertEq(feed(_R(1, bob, 50e18)).length, 2);
        assertEq(feed(_R(2, bob, 30e18)).length, 0); // already paused and confirmed: no re-bill
        (bool paused, bool incident,,, uint32 pending,, uint256 unbackedRel) = rsc.routeState(R);
        assertTrue(paused);
        assertFalse(incident);
        assertEq(pending, 2);
        assertEq(unbackedRel, 80e18);

        vm.warp(block.timestamp + 10);
        IReactive.LogRecord memory b1 = _B(1, bob, 50e18);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Matched(R, 1, bytes32(b1.txHash), 10);
        assertEq(feed(b1).length, 0, "one entry still pending: gates stay shut");
        (,,,, pending,, unbackedRel) = rsc.routeState(R);
        assertEq(pending, 1);
        assertEq(unbackedRel, 30e18);

        assertEq(feed(_B(2, bob, 30e18)).length, 2, "last match resumes both gates");
        (paused, incident,,, pending,, unbackedRel) = rsc.routeState(R);
        assertFalse(paused || incident);
        assertEq(pending, 0);
        assertEq(unbackedRel, 0);
        assertTrue(gateU.isOpen() && gateB.isOpen());
    }

    // ================================================================== saturation

    function test_seize_after_saturated_unbacked_is_capped_at_the_route_total() public {
        uint256 max = type(uint256).max;
        feed(_M(1_000_000, thief, max - 1)); // forged: pause + REPEAT
        feed(_M(1_000_001, alice, 10)); // route unbacked saturates at max (per-holder figures do not)
        (,,,,, uint256 unbacked,) = rsc.routeState(R);
        assertEq(unbacked, max);
        feed(_seized(thief, max - 1)); // route unbacked: 1, alice's own figure still 10

        IReactive.LogRecord memory s = _seized(alice, 10);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Remediated(R, 1, bytes32(s.txHash)); // never more than the route total: no underflow
        feed(s);
        (,,,,, unbacked,) = rsc.routeState(R);
        assertEq(unbacked, 0);
    }

    function test_supply_accept_deficit_lifts_burned_total_to_released_total() public {
        (uint256 r2, address col, address syn) = _addSupplyRoute();
        feed(_log(BASE, col, SENT_T0, UNI, uint160(alice), 100e18)); // lock 100
        feed(_log(UNI, syn, RECV_T0, BASE, uint160(alice), 100e18)); // mint 100
        assertEq(feed(_log(BASE, col, RECV_T0, UNI, uint160(thief), 30e18)).length, 2); // release 30, no burn
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, 0, 30e18));
        rsc.resolve(r2, 1, false);

        rsc.resolve(r2, 1, true);
        LedgerlockReactive.State memory st = rsc.getState(r2);
        assertEq(st.burnedTotal, 30e18);
        assertEq(st.releasedTotal, 30e18);
        assertEq(st.lockedTotal, 100e18, "a balanced forward side is not rebased");
        _settle();
        // after the rebase, an honest burn + release round trip stays open
        assertEq(feed(_log(UNI, syn, SENT_T0, BASE, uint160(alice), 10e18)).length, 0);
        assertEq(feed(_log(BASE, col, RECV_T0, UNI, uint160(alice), 10e18)).length, 0);
        _assertOpen(r2, 0);
    }

    // ================================================================== pending-queue head

    /// @notice Property: after every react() or resolve(), the queue head rests on a live pending entry or at the
    ///         end of the queue, never on a cleared one. `_checkOverdue` walks with the same `pendSince != 0` test after
    ///         every NONCE route event, `_onSrc` and `resolve()` jump to the end when nothing is live, and entries are
    ///         only appended. Random sequences of the 7 route operations (mint, lock, burn, release, warp, resolve,
    ///         seize) over 6 keys and 2 recipients force key collisions, replays of consumed keys, mismatched fields
    ///         and overdue entries. 4096 runs x 64 steps = 262,144 checked steps.
    /// forge-config: default.fuzz.runs = 4096
    function testFuzz_queue_head_never_rests_on_a_cleared_entry(uint256 seed) public {
        for (uint256 i; i < 64; i++) {
            uint256 x = uint256(keccak256(abi.encode(seed, i)));
            uint256 key = (x >> 8) % 6 + 1;
            uint256 amt = ((x >> 16) % 2 + 1) * 1e18;
            address to = (x >> 24) % 2 == 0 ? alice : bob;
            uint256 op = x % 7;
            if (op == 0) deliver(_M(key, to, amt));
            else if (op == 1) deliver(_L(key, to, amt));
            else if (op == 2) deliver(_B(key, to, amt));
            else if (op == 3) deliver(_R(key, to, amt));
            else if (op == 4) vm.warp(vm.getBlockTimestamp() + (x >> 32) % 90);
            else if (op == 5) rsc.resolve(R, 1, true);
            else deliver(_seized(to, amt));
            sys.takeRequests(); // the gates' acks do not touch the queue
            _assertHeadLive(i);
        }
    }

    /// @notice White-box: this test REWINDS qHead with vm.store onto a cleared entry, a state the contract never
    ///         produces itself (the property test above shows that). It pins that the routeState() view re-walks from
    ///         the head to the first live entry instead of trusting the head, so its `overdue` flag stays right.
    function test_routeState_rewalks_instead_of_trusting_a_rewound_queue_head() public {
        deliver(_L(20, bob, 1e18));
        deliver(_M(21, alice, 1e18));
        deliver(_M(22, alice, 2e18));
        deliver(_L(21, alice, 1e18)); // 21 cleared, qHead -> 1 (22 live)
        assertEq(rsc.getState(R).qHead, 1);
        bytes32 slot = keccak256(abi.encode(R, uint256(4))); // states[R] word 0 (forge inspect: states = slot 4)
        uint256 w = uint256(vm.load(address(rsc), slot)) & ~(uint256(type(uint32).max) << 120); // qHead at byte 15
        vm.store(address(rsc), slot, bytes32(w));
        assertEq(rsc.getState(R).qHead, 0, "head rewound onto the cleared entry");
        (,, bool overdue,,,,) = rsc.routeState(R);
        assertFalse(overdue);
        vm.warp(vm.getBlockTimestamp() + W + 1);
        (,, overdue,,,,) = rsc.routeState(R);
        assertTrue(overdue, "the live entry behind the cleared head is found");
    }

    // ================================================================== helpers

    function _assertHeadLive(uint256 step) internal view {
        uint256[] memory q = rsc.pendingQueue(R);
        uint32 head = rsc.getState(R).qHead;
        if (head < q.length) {
            (,,,, uint64 since,,) = rsc.slots(R, uint8(q[head] >> 128), uint128(q[head]));
            assertTrue(since != 0, string.concat("head on a cleared entry at step ", vm.toString(step)));
        } else {
            assertEq(head, q.length, "head past the end");
        }
    }

    function _routeA(address lb, address mt, address gb, address gu)
        internal
        pure
        returns (LedgerlockReactive.Route memory)
    {
        return LedgerlockReactive.Route({
            mode: LedgerlockReactive.Mode.NONCE,
            srcChain: BASE,
            dstChain: UNI,
            lockSrc: lb,
            mintDst: mt,
            keyTopic: 1,
            amountWord: 0,
            recipientTopic: 2,
            gateSrc: gb,
            gateDst: gu,
            windowSec: uint32(W),
            drillBeacon: address(0),
            keySlack: 16
        });
    }

    function _t0A() internal pure returns (uint256[6] memory) {
        return [LOCKED_T0, MINTED_T0, BURNED_T0, RELEASED_T0, SEIZED_T0, DRILL_T0];
    }

    function _addSupplyRoute() internal returns (uint256 r2, address col, address syn) {
        Gate gb2 = new Gate(address(proxy), address(rsc), address(this));
        Gate gu2 = new Gate(address(proxy), address(rsc), address(this));
        onChain(address(gb2), BASE);
        onChain(address(gu2), UNI);
        col = makeAddr("collateralRouter");
        syn = makeAddr("syntheticRouter");
        LedgerlockReactive.Route memory rt = LedgerlockReactive.Route({
            mode: LedgerlockReactive.Mode.SUPPLY,
            srcChain: BASE,
            dstChain: UNI,
            lockSrc: col,
            mintDst: syn,
            keyTopic: 0,
            amountWord: 0,
            recipientTopic: 2,
            gateSrc: address(gb2),
            gateDst: address(gu2),
            windowSec: uint32(W),
            drillBeacon: address(0),
            keySlack: 0
        });
        r2 = rsc.addRoute(rt, [SENT_T0, RECV_T0, SENT_T0, RECV_T0, 0, 0]);
    }

    function feed(IReactive.LogRecord memory rec) internal returns (CallbackResult[] memory) {
        IReactive.LogRecord[] memory recs = new IReactive.LogRecord[](1);
        recs[0] = rec;
        return _drain(recs);
    }

    function _settle() internal {
        _drain(new IReactive.LogRecord[](0));
    }

    function _log3(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 t3, uint256 amt)
        internal
        returns (IReactive.LogRecord memory l)
    {
        l = _log(chainId, emitter, t0, t1, t2, amt);
        l.topic3 = t3;
        l.opCode = 4;
    }

    function _log(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 amt)
        internal
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: chainId,
            contractAddress: emitter,
            topic0: t0,
            topic1: t1,
            topic2: t2,
            topic3: 0,
            data: abi.encode(amt),
            blockNumber: block.number,
            opCode: 3,
            blockHash: 0,
            txHash: uint256(keccak256(abi.encode("edge", ++txn))),
            logIndex: 0
        });
    }

    function _L(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(BASE, box, LOCKED_T0, n, uint160(to), amt);
    }

    function _M(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(UNI, minter, MINTED_T0, n, uint160(to), amt);
    }

    function _B(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(UNI, minter, BURNED_T0, n, uint160(to), amt);
    }

    function _R(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(BASE, box, RELEASED_T0, n, uint160(to), amt);
    }

    function _seized(address holder, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(UNI, minter, SEIZED_T0, uint160(holder), 0, amt);
    }

    function _slotOf(uint256 r, uint8 dir, uint256 key)
        internal
        view
        returns (uint256 srcAmt, bool srcSeen, bool consumed, uint64 since, uint256 pendAmt, address pendTo)
    {
        address srcTo;
        (srcAmt, srcTo, srcSeen, consumed, since, pendAmt, pendTo) = rsc.slots(r, dir, key);
    }

    function _assertOpen(uint256 r, uint256 wantUnbacked) internal view {
        (bool paused, bool incident,,, uint32 pending, uint256 unbacked,) = rsc.routeState(r);
        assertFalse(paused, "paused");
        assertFalse(incident, "incident");
        assertEq(pending, 0, "pending");
        assertEq(unbacked, wantUnbacked, "unbacked");
    }
}
