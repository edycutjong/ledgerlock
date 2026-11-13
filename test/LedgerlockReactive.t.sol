// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {OmniReactiveTest} from "reactive-kit/test/OmniReactiveTest.sol";
import {OmniSystemMock} from "reactive-kit/test/OmniSystemMock.sol";
import {CallbackResult} from "reactive-test-lib/interfaces/IReactiveInterfaces.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {LedgerlockReactive} from "../src/LedgerlockReactive.sol";
import {Gate} from "../src/Gate.sol";
import {DrillBeacon} from "../src/DrillBeacon.sol";
import {ProbeGate} from "../src/probe/ProbeGate.sol";
import {LockBox} from "../src/fixture/LockBox.sol";
import {Minter} from "../src/fixture/Minter.sol";
import {CronTopics} from "reactive-kit/CronTopics.sol";

/// @dev OpenZeppelin-style Pausable stand-in (reverts on a repeated pause/unpause), owned by a gate.
contract MockPausable {
    address public immutable owner;
    bool public paused;

    error EnforcedPause();
    error ExpectedPause();

    constructor(address owner_) {
        owner = owner_;
    }

    function pause() external {
        require(msg.sender == owner, "owner");
        if (paused) revert EnforcedPause();
        paused = true;
    }

    function unpause() external {
        require(msg.sender == owner, "owner");
        if (!paused) revert ExpectedPause();
        paused = false;
    }
}

/// @title Ledgerlock core-flow suite (Reactive Test Lib harness, Omni). Every row of the spec's Test Lib table.
contract LedgerlockReactiveTest is OmniReactiveTest {
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
    bytes4 constant PAUSE_SEL = Gate.pause.selector;
    bytes4 constant RESUME_SEL = Gate.resume.selector;

    LedgerlockReactive rsc;
    ProbeGate gateB;
    ProbeGate gateU;
    LockBox box;
    Minter minter;
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address thief = makeAddr("thief");
    uint256 txn;

    function setUp() public override {
        super.setUp();
        rsc = new LedgerlockReactive{value: 1 ether}();
        gateB = new ProbeGate(address(proxy), address(rsc), address(this));
        gateU = new ProbeGate(address(proxy), address(rsc), address(this));
        box = new LockBox(address(gateB), relayer);
        minter = new Minter(address(gateU), relayer);
        onChain(address(gateB), BASE);
        onChain(address(box), BASE);
        onChain(address(gateU), UNI);
        onChain(address(minter), UNI);
        rsc.setProxy(BASE, PROXY_B);
        rsc.setProxy(UNI, PROXY_U);
        assertEq(
            rsc.addRoute(_routeA(address(box), address(minter), address(gateB), address(gateU), address(0)), _t0A()), R
        );
    }

    // ================================================================== config

    function _routeA(address lb, address mt, address gb, address gu, address beacon)
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
            drillBeacon: beacon,
            keySlack: 16
        });
    }

    function _t0A() internal pure returns (uint256[6] memory) {
        return [LOCKED_T0, MINTED_T0, BURNED_T0, RELEASED_T0, SEIZED_T0, DRILL_T0];
    }

    function test_addRoute_subscribes_route_gates_and_failures() public view {
        // 5 route topics + 3 per gate x2 + CallbackFailure x2 (target-filtered); no Cron while nothing is owed
        assertEq(sys.activeSubscriptions(address(rsc)), 13);
        assertFalse(rsc.cronOn());
    }

    function test_addRoute_rejects_bad_config() public {
        LedgerlockReactive.Route memory rt =
            _routeA(address(box), address(minter), address(gateB), address(gateU), address(0));
        rt.keyTopic = 0;
        vm.expectRevert(LedgerlockReactive.BadRoute.selector);
        rsc.addRoute(rt, _t0A());
        rt.keyTopic = 1;
        rt.windowSec = 0;
        vm.expectRevert(LedgerlockReactive.BadRoute.selector);
        rsc.addRoute(rt, _t0A());
        vm.prank(alice);
        vm.expectRevert(LedgerlockReactive.NotOwner.selector);
        rsc.addRoute(_routeA(address(box), address(minter), address(gateB), address(gateU), address(0)), _t0A());
    }

    // ================================================================== 1. dual ledger + nonce map

    function test_matched_lock_then_mint_costs_no_callback() public {
        assertEq(_lock(alice, 100e18).length, 0);
        assertEq(_mintTx(1, alice, 100e18).length, 0);
        _assertOpen(R, 0);
        (,, bool consumed,,,) = _slot(0, 1);
        assertTrue(consumed);
    }

    function test_duplicate_delivery_is_noop() public {
        IReactive.LogRecord memory m = _M(1000, thief, 1e18);
        feed(m);
        (,,,, uint32 pending, uint256 unbacked,) = rsc.routeState(R);
        feed(m); // same (chainId, txHash, logIndex)
        (,,,, uint32 pending2, uint256 unbacked2,) = rsc.routeState(R);
        assertEq(pending2, pending);
        assertEq(unbacked2, unbacked);
        assertEq(unbacked, 1e18);
    }

    function test_same_nonce_opposite_directions_interleaved() public {
        // (r, dir, key) namespace: equal nonce and amount both ways; each entry is cleared only by its own direction
        assertEq(feed(_L(9, alice, 500e18)).length, 0);
        assertEq(feed(_B(9, bob, 500e18)).length, 0);
        assertEq(feed(_M(9, alice, 500e18)).length, 0);
        assertEq(feed(_R(9, bob, 500e18)).length, 0);
        _assertOpen(R, 0);
    }

    function test_reverse_direction_release_before_burn_is_unmatched() public {
        // a release whose burn never arrived (the Nomad shape) is the mirror of the forward attack
        feed(_B(1, bob, 50e18));
        assertEq(feed(_R(1, bob, 50e18)).length, 0); // matched
        CallbackResult[] memory r = feed(_R(1, bob, 50e18)); // replayed release on a consumed burn nonce
        assertEq(r.length, 2);
        (bool paused, bool incident,,,,, uint256 unbackedRel) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(unbackedRel, 50e18);
    }

    // ================================================================== 2. immediate pause on an unmatched mint

    function test_unmatched_mint_pauses_both_chains_in_one_react() public {
        feed(_L(1, alice, 1e18));
        feed(_L(2, alice, 1e18));
        IReactive.LogRecord memory m = _M(3, alice, 500e18); // plausible key (highest lock 2)
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.PauseRequested(R, 1, bytes32(m.txHash), 3);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Mismatch(R, LedgerlockReactive.Side.MINT, 3, 500e18, alice, bytes32(m.txHash), 1);
        deliver(m);
        // one react() -> two callback requests to two chains: mint side first, then the release side
        OmniSystemMock.Request[] memory q = sys.takeRequests();
        assertEq(q.length, 2);
        assertEq(q[0].chainId, UNI);
        assertEq(q[0].recipient, address(gateU));
        assertEq(q[1].chainId, BASE);
        assertEq(q[1].recipient, address(gateB));
        assertEq(q[0].gasLimit, 1_000_000);
        (bytes4 sel, uint256 route, uint64 e, bytes32 origin, uint256 key) = _decode(q[0].payload);
        assertEq(sel, PAUSE_SEL);
        assertEq(route, R);
        assertEq(e, 1);
        assertEq(origin, bytes32(m.txHash)); // the origin tx hash travels in the callback
        assertEq(key, 3);
        (bool paused, bool incident,,, uint32 pending,,) = rsc.routeState(R);
        assertTrue(paused);
        assertFalse(incident); // plausible: waits for its own lock, no latch yet
        assertEq(pending, 1);
    }

    function test_unmatched_mint_end_to_end_gates_shut_and_copycat_reverts() public {
        CallbackResult[] memory r = _mintTx(1_000_000, thief, 500e18);
        assertEq(r.length, 2);
        assertAllSucceeded(r);
        assertFalse(gateU.isOpen());
        assertFalse(gateB.isOpen());
        assertEq(gateU.lastEpoch(), 1);
        // copycat from the stolen key: reverts at the Minter, before any event
        vm.prank(relayer);
        vm.expectRevert(Minter.GatePaused.selector);
        minter.mint(1_000_001, thief, 500e18);
        // release side frozen too
        vm.prank(relayer);
        vm.expectRevert(LockBox.GatePaused.selector);
        box.releaseByRelayer(1, thief, 1e18);
        // acks came back: nothing owed, Cron watchdog unsubscribed
        assertEq(rsc.outstandingAcks(), 0);
        assertFalse(rsc.cronOn());
        assertEq(sys.activeSubscriptions(address(rsc)), 13);
    }

    function test_forged_keys_pause_once_and_latch_repeat() public {
        IReactive.LogRecord memory m1 = _M(1_000_001, thief, 500e18);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.REPEAT, 1);
        assertEq(feed(m1).length, 2);
        assertEq(feed(_M(1_000_002, thief, 500e18)).length, 0); // only adds to unbacked
        (bool paused, bool incident,, uint64 epoch, uint32 pending, uint256 unbacked,) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(epoch, 1);
        assertEq(pending, 2);
        assertEq(unbacked, 1000e18);
    }

    function test_same_key_copycats_count_and_do_not_rebill() public {
        assertEq(feed(_M(2_000_005, thief, 500e18)).length, 2);
        assertEq(feed(_M(2_000_005, thief, 500e18)).length, 0);
        assertEq(feed(_M(2_000_005, thief, 500e18)).length, 0);
        (,,,, uint32 pending, uint256 unbacked,) = rsc.routeState(R);
        assertEq(pending, 1);
        assertEq(unbacked, 1500e18);
        assertEq(rsc.getState(R).copycatsSameKey, 2);
        assertEq(gateU.lastEpoch(), 1);
    }

    function test_recipient_swap_on_locked_nonce_latches() public {
        feed(_L(7, alice, 500e18));
        assertEq(feed(_M(7, thief, 500e18)).length, 2);
        (bool paused, bool incident,,,, uint256 unbacked,) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(unbacked, 500e18);
        assertEq(rsc.holderUnbacked(R, thief), 500e18);
        assertEq(uint8(rsc.getState(R).cause), uint8(LedgerlockReactive.Cause.REPEAT));
    }

    function test_amount_mismatch_latches() public {
        feed(_L(4, alice, 100e18));
        assertEq(feed(_M(4, alice, 1000e18)).length, 2);
        (, bool incident,,,,,) = rsc.routeState(R);
        assertTrue(incident);
        assertEq(uint8(rsc.getState(R).cause), uint8(LedgerlockReactive.Cause.REPEAT));
    }

    function test_replayed_nonce_pauses() public {
        feed(_L(5, alice, 25e18));
        assertEq(feed(_M(5, alice, 25e18)).length, 0);
        assertEq(feed(_M(5, alice, 25e18)).length, 2); // consumed nonce: unmatched
        (bool paused, bool incident,,,,,) = rsc.routeState(R);
        assertTrue(paused && incident);
    }

    function test_flood_latch_after_max_pending() public {
        feed(_L(100, alice, 1e18)); // keys 1..33 stay plausible (<= highest lock + K)
        for (uint256 k = 1; k <= 32; k++) {
            feed(_M(k, alice, 1e18));
        }
        (, bool incident,,, uint32 pending,,) = rsc.routeState(R);
        assertFalse(incident);
        assertEq(pending, 32);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.FLOOD, 1);
        feed(_M(33, alice, 1e18));
    }

    // ================================================================== 3. auto-resume on a matching lock within W

    function test_late_lock_within_W_resumes() public {
        assertEq(feed(_M(2, alice, 40e18)).length, 2);
        vm.warp(block.timestamp + 30);
        IReactive.LogRecord memory l = _L(2, alice, 40e18);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Matched(R, 2, bytes32(l.txHash), 30);
        CallbackResult[] memory r = feed(l);
        assertEq(r.length, 2);
        (bytes4 sel,, uint64 e,,) = _decode(r[0].payload);
        assertEq(sel, RESUME_SEL);
        assertEq(e, 2);
        _assertOpen(R, 0);
        assertTrue(gateU.isOpen() && gateB.isOpen());
    }

    function test_mint_before_lock_end_to_end_with_fixture() public {
        // forced fill-before-deposit (the optimistic relayer): mint first, then the real lock
        _mintTx(1, alice, 40e18);
        assertFalse(gateU.isOpen());
        vm.warp(block.timestamp + 5);
        assertEq(_lock(alice, 40e18).length, 2);
        assertTrue(gateU.isOpen() && gateB.isOpen());
        assertEq(rsc.outstandingAcks(), 0);
    }

    function test_lock_after_W_latches_no_resume() public {
        feed(_M(3, alice, 40e18));
        vm.warp(block.timestamp + W + 1);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.LATE_LOCK, 1);
        assertEq(feed(_L(3, alice, 40e18)).length, 0);
        (bool paused, bool incident,,, uint32 pending, uint256 unbacked,) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(pending, 0);
        assertEq(unbacked, 0); // backed after all; reopen needs resolve() only
    }

    function test_lock_with_other_recipient_does_not_resume() public {
        feed(_M(1, alice, 40e18));
        assertEq(feed(_L(1, bob, 40e18)).length, 0);
        (bool paused,,,, uint32 pending,,) = rsc.routeState(R);
        assertTrue(paused);
        assertEq(pending, 1);
    }

    function test_two_plausible_pendings_resume_only_after_both() public {
        assertEq(feed(_M(7, alice, 25e18)).length, 2);
        assertEq(feed(_M(8, alice, 40e18)).length, 0);
        assertEq(feed(_L(7, alice, 25e18)).length, 0); // one still pending: gates stay shut
        assertFalse(gateU.isOpen());
        assertEq(feed(_L(8, alice, 40e18)).length, 2);
        _assertOpen(R, 0);
    }

    function test_staggered_honest_pair_no_latch() public {
        uint256 t0 = block.timestamp;
        feed(_M(10, alice, 25e18));
        vm.warp(t0 + 30);
        feed(_M(11, alice, 40e18));
        vm.warp(t0 + 40);
        feed(_L(10, alice, 25e18));
        vm.warp(t0 + 70);
        assertEq(feed(_L(11, alice, 40e18)).length, 2); // each waited <= 40 s for its own lock
        _assertOpen(R, 0);
    }

    function test_mint_lock_replay_latches() public {
        feed(_M(9, alice, 25e18));
        assertEq(feed(_L(9, alice, 25e18)).length, 2); // resume
        _assertOpen(R, 0);
        assertEq(feed(_M(9, alice, 25e18)).length, 2); // replay of a consumed key
        (bool paused, bool incident,,,,,) = rsc.routeState(R);
        assertTrue(paused && incident);
    }

    function test_overdue_pending_latches_lazily() public {
        feed(_L(4, alice, 1e18));
        feed(_M(5, alice, 40e18));
        vm.warp(block.timestamp + W + 1);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.OVERDUE, 1);
        feed(_L(6, bob, 1e18)); // any route event
        (, bool incident, bool overdue,,,,) = rsc.routeState(R);
        assertTrue(incident && overdue);
    }

    function test_plausible_forger_holds_route_shut_then_legit_mint_reverts() public {
        feed(_L(11, alice, 1e18));
        _mintTx(12, thief, 500e18); // forged, plausible key (fail-closed hold)
        vm.warp(block.timestamp + 600);
        _lock(bob, 25e18); // Locked(1) on the fixture: route event -> OVERDUE
        (bool paused, bool incident,,,,,) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(uint8(rsc.getState(R).cause), uint8(LedgerlockReactive.Cause.OVERDUE));
        vm.prank(relayer);
        vm.expectRevert(Minter.GatePaused.selector);
        minter.mint(1, bob, 25e18);
    }

    // ================================================================== 4. incident mode + resolve + deficit rule

    function test_resolve_with_deficit_reverts_unless_accepted() public {
        feed(_M(2_000_001, thief, 500e18));
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, 500e18, 0));
        rsc.resolve(R, 1, false);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Resolved(R, 1, 500e18, 0, true, 2);
        rsc.resolve(R, 1, true);
        (CallbackResult[] memory r,) = runCallbacks();
        assertEq(r.length, 2);
        (bool paused, bool incident,,, uint32 pending, uint256 unbacked,) = rsc.routeState(R);
        assertFalse(paused || incident);
        assertEq(pending, 0);
        assertEq(unbacked, 0);
    }

    function test_attack_seize_resolve_redeem_fails() public {
        _mintTx(2_000_001, thief, 500e18);
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, 500e18, 0));
        rsc.resolve(R, 1, false);
        cycle(address(this), address(minter), abi.encodeCall(Minter.seize, (thief, 500e18)));
        (,,,,, uint256 unbacked,) = rsc.routeState(R);
        assertEq(unbacked, 0);
        rsc.resolve(R, 1, false);
        _settle();
        assertTrue(gateU.isOpen() && gateB.isOpen());
        // the attacker's redemption has nothing to burn
        vm.prank(thief);
        vm.expectRevert(Minter.Insufficient.selector);
        minter.burn(thief, 500e18);
    }

    function test_resolve_then_replay_is_unmatched() public {
        feed(_M(14, thief, 500e18));
        feed(_seized(thief, 500e18));
        rsc.resolve(R, 1, false);
        _settle();
        feed(_L(14, thief, 500e18)); // the key was consumed by resolve()
        assertEq(feed(_M(14, thief, 500e18)).length, 2);
        (bool paused, bool incident,,,,,) = rsc.routeState(R);
        assertTrue(paused && incident);
    }

    function test_consumed_key_then_legit_lock_same_key() public {
        // plausible forger on nonce 1 (before its lock exists) -> seize -> resolve; the later legit lock of nonce 1
        _mintTx(1, thief, 500e18);
        cycle(address(this), address(minter), abi.encodeCall(Minter.seize, (thief, 500e18)));
        rsc.resolve(R, 1, false);
        _settle();
        _lock(bob, 500e18); // nonce 1
        vm.prank(relayer);
        vm.expectRevert(Minter.NonceUsed.selector); // the bridge cannot mint it: no Minted, no false resume
        minter.mint(1, bob, 500e18);
        _assertOpen(R, 0);
    }

    function test_resolve_only_owner_and_valid_route() public {
        vm.prank(alice);
        vm.expectRevert(LedgerlockReactive.NotOwner.selector);
        rsc.resolve(R, 1, true);
        vm.expectRevert(LedgerlockReactive.BadRoute.selector);
        rsc.resolve(7, 1, true);
    }

    function test_resolve_when_not_paused_requests_nothing() public {
        rsc.resolve(R, 1, false);
        assertEq(sys.takeRequests().length, 0);
    }

    function test_drill_pauses_both_and_latches_until_resolve() public {
        (uint256 r2, DrillBeacon beacon, Gate gb2, Gate gu2) = _addRouteWithBeacon();
        CallbackResult[] memory r = cycle(address(this), address(beacon), abi.encodeCall(DrillBeacon.fire, (r2)));
        assertEq(r.length, 2);
        assertFalse(gb2.isOpen() || gu2.isOpen());
        (bool paused, bool incident,,,,,) = rsc.routeState(r2);
        assertTrue(paused && incident);
        LedgerlockReactive.Cause cause = rsc.getState(r2).cause;
        assertEq(uint8(cause), uint8(LedgerlockReactive.Cause.DRILL));
        rsc.resolve(r2, 7, false); // balanced: no deficit
        _settle();
        assertTrue(gb2.isOpen() && gu2.isOpen());
        _assertOpen(R, 0); // route A untouched
    }

    // ================================================================== 5. two-destination callbacks, two routes

    function test_two_routes_are_independent() public {
        (uint256 r2,, Gate gb2, Gate gu2) = _addRouteWithBeacon();
        _mintTx(1_000_000, thief, 500e18); // attack on route A only
        assertFalse(gateU.isOpen() || gateB.isOpen());
        assertTrue(gb2.isOpen() && gu2.isOpen());
        (bool p2,,,,,,) = rsc.routeState(r2);
        assertFalse(p2);
    }

    function test_cron_watch_exists_only_while_an_ack_is_owed() public {
        deliver(_M(1_000_000, thief, 1e18));
        assertTrue(rsc.cronOn());
        assertEq(rsc.outstandingAcks(), 2);
        assertEq(sys.activeSubscriptions(address(rsc)), 14);
        (, IReactive.LogRecord[] memory acksBack) = runCallbacks();
        assertEq(acksBack.length, 2);
        feed(acksBack[0]);
        assertTrue(rsc.cronOn()); // one still owed
        feed(acksBack[1]);
        assertFalse(rsc.cronOn());
        assertEq(sys.activeSubscriptions(address(rsc)), 13);
    }

    // ================================================================== 6. CallbackFailure retry + ack watchdog

    function test_callback_failure_one_retry_same_epoch() public {
        deliver(_M(1_000_000, thief, 1e18));
        sys.takeRequests(); // both deliveries fail at the destination
        IReactive.LogRecord memory f = _fail(UNI, address(gateU), PAUSE_SEL, 1);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.Retried(R, UNI, 1);
        deliver(f);
        OmniSystemMock.Request[] memory q = sys.takeRequests();
        assertEq(q.length, 1);
        assertEq(q[0].recipient, address(gateU));
        (bytes4 sel,, uint64 e,,) = _decode(q[0].payload);
        assertEq(sel, PAUSE_SEL);
        assertEq(e, 1);
        deliver(f); // duplicate delivery of the same failure log: no second retry
        assertEq(sys.takeRequests().length, 0);
    }

    function test_double_callback_failure_failsafe() public {
        deliver(_M(1_000_000, thief, 1e18));
        sys.takeRequests();
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1));
        sys.takeRequests();
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.GateUnreachable(R, UNI, 1);
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1));
        LedgerlockReactive.Cause cause = rsc.getState(R).cause;
        assertEq(uint8(cause), uint8(LedgerlockReactive.Cause.REPEAT)); // forged key latched first; FAILSAFE does not overwrite
        (bool owed,,,,,,,,) = rsc.acks(R, 0);
        assertFalse(owed);
    }

    function test_double_failure_on_plausible_pause_latches_failsafe() public {
        deliver(_M(1, alice, 1e18)); // plausible: no REPEAT latch
        sys.takeRequests();
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1));
        sys.takeRequests();
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.FAILSAFE, 1);
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1));
    }

    function test_obsolete_failure_ignored() public {
        feed(_M(2, alice, 1e18)); // pause epoch 1 (acked)
        feed(_L(2, alice, 1e18)); // resume epoch 2 (acked)
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1));
        assertEq(sys.takeRequests().length, 0);
        (, bool incident,,,,,) = rsc.routeState(R);
        assertFalse(incident);
    }

    function test_failure_from_unknown_proxy_or_gate_ignored() public {
        deliver(_M(1, alice, 1e18));
        sys.takeRequests();
        IReactive.LogRecord memory f = _fail(UNI, address(gateU), PAUSE_SEL, 1);
        f.contractAddress = address(0xBAD);
        deliver(f);
        IReactive.LogRecord memory g = _fail(UNI, address(0xBEEF), PAUSE_SEL, 1);
        deliver(g);
        assertEq(sys.takeRequests().length, 0);
    }

    function test_failed_resume_twice_gate_stays_paused_no_latch() public {
        feed(_M(3, alice, 1e18)); // pause epoch 1
        gateU.setFailNext(true);
        feed(_L(3, alice, 1e18)); // resume epoch 2: U fails, B resumes
        assertFalse(gateU.isOpen());
        deliver(_fail(UNI, address(gateU), RESUME_SEL, 2));
        runCallbacks(); // the retry fails too
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.GateUnreachable(R, UNI, 2);
        deliver(_fail(UNI, address(gateU), RESUME_SEL, 2));
        (, bool incident,,,,,) = rsc.routeState(R);
        assertFalse(incident); // a stuck RESUME never latches; that gate stays shut (split state)
        assertFalse(gateU.isOpen());
        assertTrue(gateB.isOpen());
    }

    function test_isolated_mint_gate_in_debt_failsafe_via_cron() public {
        gateU.setFailNext(true); // silent: no ack, no failure log (an indebted gate is silent)
        _mintTx(1, alice, 1e18);
        assertFalse(gateB.isOpen());
        assertTrue(gateU.isOpen());
        assertTrue(rsc.cronOn());
        vm.warp(block.timestamp + 31);
        CallbackResult[] memory r = cron(CronTopics.CRON10); // one re-request (to U only)
        assertEq(r.length, 1);
        assertEq(r[0].target, address(gateU));
        vm.warp(block.timestamp + 31);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.GateUnreachable(R, UNI, 1);
        cron(CronTopics.CRON10);
        LedgerlockReactive.Cause cause = rsc.getState(R).cause;
        assertEq(uint8(cause), uint8(LedgerlockReactive.Cause.FAILSAFE));
        assertFalse(rsc.cronOn()); // watchdog unsubscribed
        assertEq(sys.activeSubscriptions(address(rsc)), 13);
    }

    function test_lost_ack_log_regenerated_by_rerequest() public {
        deliver(_M(1_000_000, thief, 1e18));
        runCallbacks(); // pause executes at epoch 1, its Paused logs are withheld
        assertFalse(gateU.isOpen());
        vm.warp(block.timestamp + 31);
        CallbackResult[] memory r = cron(CronTopics.CRON10); // re-request at epoch 1 -> gates re-emit Paused(1)
        assertEq(r.length, 2);
        assertAllSucceeded(r);
        assertEq(rsc.outstandingAcks(), 0);
        assertFalse(rsc.cronOn());
    }

    function test_silent_resume_unreachable_without_latch() public {
        feed(_M(2_000_001, thief, 500e18));
        gateU.setFailNext(true);
        rsc.resolve(R, 1, true);
        _settle(); // U's resume dropped silently, B resumes
        vm.warp(block.timestamp + 31);
        cron(CronTopics.CRON10);
        vm.warp(block.timestamp + 31);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.GateUnreachable(R, UNI, 2);
        cron(CronTopics.CRON10);
        (bool paused, bool incident,,,,,) = rsc.routeState(R);
        assertFalse(paused || incident);
        assertFalse(gateU.isOpen());
        assertTrue(gateB.isOpen());
    }

    function test_ack_from_older_epoch_does_not_settle() public {
        deliver(_M(1_000_000, thief, 1e18));
        sys.takeRequests();
        feed(_ack(UNI, address(gateU), 0)); // epoch 0 is not what is owed
        (bool owed,,,,,,,,) = rsc.acks(R, 0);
        assertTrue(owed);
    }

    // ================================================================== Gate

    function test_gate_rejects_spoofed_callbacks() public {
        vm.expectRevert();
        gateU.pause(address(rsc), R, 9, bytes32(0), 0); // not the proxy
        injectOverride = thief; // wrong injected reactive contract
        deliver(_M(1_000_000, thief, 1e18));
        (CallbackResult[] memory r,) = runCallbacks();
        assertFalse(r[0].success);
        assertTrue(gateU.isOpen());
    }

    function test_stale_resume_ignored_by_gate() public {
        feed(_M(1_000_000, thief, 1e18)); // gate epoch 1 = pause
        vm.prank(address(proxy));
        vm.expectEmit(address(gateU));
        emit Gate.StaleEpoch(0, 1);
        gateU.resume(address(rsc), R, 0, bytes32(0), 0);
        vm.prank(address(proxy));
        gateU.resume(address(rsc), R, 1, bytes32(0), 0); // same epoch, other op: stale too
        assertFalse(gateU.isOpen());
    }

    function test_gate_same_epoch_same_op_reemits_ack() public {
        feed(_M(1_000_000, thief, 1e18));
        vm.prank(address(proxy));
        vm.expectEmit(address(gateU));
        emit Gate.Paused(R, 1, bytes32(uint256(7)), 0);
        gateU.pause(address(rsc), R, 1, bytes32(uint256(7)), 0);
        assertEq(gateU.lastEpoch(), 1);
    }

    function test_guardian_hold_survives_rsc_resume() public {
        gateU.guardianPause();
        feed(_M(2, alice, 1e18));
        CallbackResult[] memory r = feed(_L(2, alice, 1e18)); // matched out-of-order: RSC resume at epoch 2
        assertEq(r.length, 2);
        assertFalse(gateU.isOpen()); // HeldByGuardian
        assertEq(gateU.lastEpoch(), 2);
        assertEq(rsc.outstandingAcks(), 0); // HeldByGuardian settles the ack: no false GateUnreachable
        gateU.guardianResume();
        assertTrue(gateU.isOpen()); // the RSC's last decision was RESUME
    }

    function test_guardian_cannot_lift_an_rsc_pause() public {
        feed(_M(1_000_000, thief, 1e18));
        gateU.guardianPause();
        gateU.guardianResume();
        assertFalse(gateU.isOpen());
    }

    function test_guardian_paused_target_then_rsc_pause_no_revert() public {
        Gate gb = new Gate(address(proxy), address(rsc), address(this));
        MockPausable ism = new MockPausable(address(gb));
        gb.setTarget(address(ism));
        Gate gu = new Gate(address(proxy), address(rsc), address(this));
        onChain(address(gb), BASE);
        onChain(address(gu), UNI);
        address lb = makeAddr("lb2");
        address mt = makeAddr("mt2");
        uint256 r2 = rsc.addRoute(_routeA(lb, mt, address(gb), address(gu), address(0)), _t0A());
        gb.guardianPause(); // the ISM is already paused by the human
        assertTrue(ism.paused());
        CallbackResult[] memory r = feed(_log(UNI, mt, MINTED_T0, 1_000_000, uint160(thief), abi.encode(uint256(1e18))));
        assertEq(r.length, 2);
        assertAllSucceeded(r); // no revert, no CallbackFailure, no false FAILSAFE
        assertEq(gb.lastEpoch(), 1);
        rsc.resolve(r2, 1, true);
        _settle();
        assertTrue(ism.paused()); // guardian hold keeps the ISM shut
        gb.guardianResume();
        assertFalse(ism.paused());
    }

    function test_probe_gate_fail_next_makes_callback_fail() public {
        gateU.setFailNext(true);
        gateB.setFailNext(true);
        CallbackResult[] memory r = _mintTx(1000, thief, 1e18);
        assertEq(r.length, 2);
        assertFalse(r[0].success || r[1].success);
        assertEq(bytes4(r[0].returnData), ProbeGate.ProbeFail.selector);
    }

    // ================================================================== 7. reorg / duplicate delivery

    function test_reorged_lock_is_simulated_passes_as_matched() public {
        // SIMULATED reorg: Locked(6) is delivered, then "removed" on Base (never re-delivered). The mint passes as matched:
        // this documents the residual risk (no confirmation depth inside the headline loop).
        feed(_L(6, alice, 100e18));
        assertEq(feed(_M(6, alice, 100e18)).length, 0);
        _assertOpen(R, 0);
    }

    function test_reorg_redelivery_of_same_log_is_counted_once() public {
        IReactive.LogRecord memory l = _L(6, alice, 100e18);
        feed(l);
        feed(l); // re-delivered after a reorg back to the same block: idempotent on (chainId, txHash, logIndex)
        assertEq(feed(_M(6, alice, 100e18)).length, 0);
        assertEq(feed(_M(6, alice, 100e18)).length, 2); // only one mint was backed
    }

    // ================================================================== 8. adapter config: SUPPLY mode, Nomad release

    function test_supply_mode_pauses_and_latches_on_violation_no_auto_resume() public {
        (uint256 r2, address col, address syn) = _addSupplyRoute();
        assertEq(feed(_log(BASE, col, SENT_T0, UNI, uint160(alice), abi.encode(uint256(100e18)))).length, 0);
        assertEq(feed(_log(UNI, syn, RECV_T0, BASE, uint160(alice), abi.encode(uint256(100e18)))).length, 0);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(r2, LedgerlockReactive.Cause.SUPPLY, 1);
        assertEq(feed(_log(UNI, syn, RECV_T0, BASE, uint160(alice), abi.encode(uint256(50e18)))).length, 2);
        // the late Sent reconciles the totals but never auto-resumes (totals cannot name the bad transfer)
        assertEq(feed(_log(BASE, col, SENT_T0, UNI, uint160(alice), abi.encode(uint256(50e18)))).length, 0);
        (bool paused, bool incident,,,, uint256 def,) = rsc.routeState(r2);
        assertTrue(paused && incident);
        assertEq(def, 0);
        rsc.resolve(r2, 2, false); // balanced by now: reopens without acceptDeficit
        _settle();
    }

    function test_supply_latch_requires_accept_deficit() public {
        (uint256 r2,, address syn) = _addSupplyRoute();
        feed(_log(UNI, syn, RECV_T0, BASE, uint160(thief), abi.encode(uint256(70e18))));
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, 70e18, 0));
        rsc.resolve(r2, 1, false);
        rsc.resolve(r2, 1, true);
        (,,,,, uint256 def,) = rsc.routeState(r2);
        assertEq(def, 0);
    }

    function test_nomad_release_pauses_both() public {
        assertEq(feed(_R(2_000_000, thief, 500e18)).length, 2);
        (bool paused, bool incident,,,,, uint256 unbackedRel) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(unbackedRel, 500e18);
    }

    function test_nomad_class_fixture_process_release_pauses_and_blocks_next() public {
        box.seedCollateral(5000e18);
        box.initialize(bytes32(0)); // the Nomad-class upgrade bug: confirmAt[0] = 1
        bytes memory msg1 = abi.encode(uint64(2_000_000), thief, 500e18);
        CallbackResult[] memory r = cycle(thief, address(box), abi.encodeCall(LockBox.process, (msg1)));
        assertEq(r.length, 2);
        assertFalse(gateB.isOpen());
        bytes memory msg2 = abi.encode(uint64(2_000_001), thief, 500e18);
        vm.prank(thief);
        vm.expectRevert(LockBox.GatePaused.selector);
        box.process(msg2);
        assertEq(box.totalReleased(), 500e18);
        (,,,,,, uint256 unbackedRel) = rsc.routeState(R);
        assertEq(unbackedRel, 500e18);
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, 0, 500e18));
        rsc.resolve(R, 1, false); // released collateral cannot be seized: reopen only with acceptDeficit
    }

    function test_legit_burn_release_roundtrip_with_fixture() public {
        _lock(alice, 100e18);
        _mintTx(1, alice, 100e18);
        CallbackResult[] memory r = cycle(alice, address(minter), abi.encodeCall(Minter.burn, (alice, 60e18)));
        assertEq(r.length, 0);
        vm.prank(relayer);
        vm.recordLogs();
        box.releaseByRelayer(1, alice, 60e18);
        // deliver the Released log: it matches the Burned record, no callback
        IReactive.LogRecord memory rel = _R(1, alice, 60e18);
        assertEq(feed(rel).length, 0);
        _assertOpen(R, 0);
        assertEq(box.collateral(), 40e18);
    }

    // ================================================================== fixture + access

    function test_fixture_caps_and_relayer_only() public {
        vm.expectRevert(LockBox.OverCap.selector);
        box.lock(alice, 501e18);
        vm.expectRevert(Minter.NotRelayer.selector);
        minter.mint(1, alice, 1);
        vm.prank(relayer);
        vm.expectRevert(Minter.OverCap.selector);
        minter.mint(1, alice, 501e18);
        box.seedCollateral(1000e18);
        vm.prank(relayer);
        vm.expectRevert(LockBox.OverCap.selector);
        box.releaseByRelayer(1, alice, 501e18);
        box.initialize(bytes32(0));
        vm.expectRevert(LockBox.OverCap.selector);
        box.process(abi.encode(uint64(9), alice, 501e18));
        vm.prank(relayer);
        minter.mint(1, alice, 1);
        vm.prank(relayer);
        vm.expectRevert(Minter.NonceUsed.selector);
        minter.mint(1, alice, 1);
    }

    function test_unproven_message_rejected_without_bug() public {
        vm.expectRevert(LockBox.NotProven.selector);
        box.process(abi.encode(uint64(9), alice, 1e18));
    }

    function test_react_only_system() public {
        IReactive.LogRecord memory m = _M(1, alice, 1);
        vm.prank(alice);
        vm.expectRevert();
        rsc.react(m);
    }

    function test_unknown_emitter_ignored() public {
        IReactive.LogRecord memory m = _M(1_000_000, thief, 1e18);
        m.contractAddress = address(0xDEAD);
        assertEq(feed(m).length, 0);
        _assertOpen(R, 0);
    }

    // ================================================================== fuzz: honest traffic never latches

    /// @dev n honest transfers, each lock and mint delivered in a random order with random gaps < W/2 between steps:
    ///      the route never latches and ends open with nothing unbacked.
    function testFuzz_honest_out_of_order_never_latches(uint256 seed, uint8 nRaw) public {
        uint256 n = bound(nRaw, 1, 12);
        for (uint256 k = 1; k <= n; k++) {
            uint256 amt = (uint256(keccak256(abi.encode(seed, k))) % 500e18) + 1;
            bool mintFirst = uint256(keccak256(abi.encode(seed, k, "o"))) % 2 == 0;
            uint256 gap = uint256(keccak256(abi.encode(seed, k, "g"))) % (W / 2);
            if (mintFirst) feed(_M(k, alice, amt));
            else feed(_L(k, alice, amt));
            vm.warp(block.timestamp + gap);
            if (mintFirst) feed(_L(k, alice, amt));
            else feed(_M(k, alice, amt));
        }
        _assertOpen(R, 0);
        (, bool incident,,,,,) = rsc.routeState(R);
        assertFalse(incident);
        assertEq(rsc.outstandingAcks(), 0);
    }

    // ================================================================== QA round 1 regressions

    function test_queue_head_skips_cleared_entries_gas_flat() public {
        // 60 honest out-of-order fills (mint, then its lock) must not leave a walk behind for the next pause
        uint256 g1 = _pauseGasAfterFills(1);
        uint256 g60 = _pauseGasAfterFills(60);
        assertEq(rsc.getState(R).qHead, rsc.pendingQueue(R).length); // nothing live: the head skipped every cleared entry
        assertLe(g60, g1 + 10_000, "pause gas grows with history");
    }

    function _pauseGasAfterFills(uint256 n) internal returns (uint256 g) {
        uint256 base = rsc.pendingQueue(R).length + 1;
        for (uint256 i; i < n; i++) {
            feed(_M(base + i, alice, 1e18));
            feed(_L(base + i, alice, 1e18));
        }
        IReactive.LogRecord memory m = _M(base + n, alice, 1e18); // plausible: highest lock is base + n - 1
        vm.prank(SYSTEM_ADDR);
        g = gasleft();
        rsc.react(m); // measured directly: the harness's subscription matching grows with every Cron sub/unsub
        g -= gasleft();
        _settle();
        feed(_L(base + n, alice, 1e18)); // reopen for the next round
        _assertOpen(R, 0);
    }

    function test_accepted_deficit_stale_holder_seize_cannot_hide_new_deficit() public {
        address thief2 = makeAddr("thief2");
        feed(_M(2_000_001, thief, 500e18));
        rsc.resolve(R, 1, true); // deficit accepted: era 0 -> 1
        _settle();
        feed(_M(2_000_002, thief2, 300e18)); // a new attacker
        feed(_seized(thief, 500e18)); // seizing the OLD attacker's tokens remediates nothing in the new era
        (,,,,, uint256 unbacked,) = rsc.routeState(R);
        assertEq(unbacked, 300e18);
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, 300e18, 0));
        rsc.resolve(R, 1, false);
        feed(_seized(thief2, 300e18));
        rsc.resolve(R, 1, false);
    }

    function test_missing_ack_on_gate_b_failsafe_via_cron() public {
        gateB.setFailNext(true); // the release-side gate is silent
        _mintTx(1, alice, 1e18); // plausible key: no REPEAT latch
        assertFalse(gateU.isOpen());
        vm.warp(block.timestamp + 31);
        CallbackResult[] memory r = cron(CronTopics.CRON10);
        assertEq(r.length, 1);
        assertEq(r[0].target, address(gateB));
        vm.warp(block.timestamp + 31);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.GateUnreachable(R, BASE, 1);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.FAILSAFE, 1);
        cron(CronTopics.CRON10);
        assertFalse(rsc.cronOn());
    }

    function test_failure_after_ack_is_obsolete() public {
        deliver(_M(1, alice, 1e18));
        sys.takeRequests(); // silent
        vm.warp(block.timestamp + 31);
        cron(CronTopics.CRON10); // watchdog re-request (executes: gates pause and ack)
        // a late CallbackFailure for the ORIGINAL call arrives after the gates already acked: obsolete, ignored
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1));
        assertEq(sys.takeRequests().length, 0);
        (, bool incident,,,,,) = rsc.routeState(R);
        assertFalse(incident);
    }

    function test_failure_while_watchdog_rerequest_in_flight_retries_once_more() public {
        deliver(_M(1, alice, 1e18));
        sys.takeRequests();
        vm.warp(block.timestamp + 31);
        deliver(_L(50, bob, 1e18)); // any route event runs the watchdog: one re-request per gate
        assertEq(sys.takeRequests().length, 2); // dropped again
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1)); // failure of the original: its own retry, not GateUnreachable
        assertEq(sys.takeRequests().length, 1);
        (bool owed,,,,,,,,) = rsc.acks(R, 0);
        assertTrue(owed);
    }

    function test_supply_reverse_violation_release_without_burn() public {
        (uint256 r2, address col, address syn) = _addSupplyRoute();
        feed(_log(BASE, col, SENT_T0, UNI, uint160(alice), abi.encode(uint256(100e18)))); // lock 100
        feed(_log(UNI, syn, RECV_T0, BASE, uint160(alice), abi.encode(uint256(100e18)))); // mint 100
        feed(_log(UNI, syn, SENT_T0, BASE, uint160(alice), abi.encode(uint256(40e18)))); // burn 40
        assertEq(feed(_log(BASE, col, RECV_T0, UNI, uint160(alice), abi.encode(uint256(40e18)))).length, 0); // release 40
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(r2, LedgerlockReactive.Cause.SUPPLY, 1);
        assertEq(feed(_log(BASE, col, RECV_T0, UNI, uint160(thief), abi.encode(uint256(1e18)))).length, 2);
        (,,,,,, uint256 defRel) = rsc.routeState(r2);
        assertEq(defRel, 1e18);
    }

    function test_zero_amount_pending_is_live_and_matchable() public {
        assertEq(feed(_M(1, alice, 0)).length, 2);
        (,,,, uint32 pending,,) = rsc.routeState(R);
        assertEq(pending, 1);
        assertEq(feed(_L(1, alice, 0)).length, 2); // matched -> resume
        _assertOpen(R, 0);
    }

    function test_drill_for_another_route_id_ignored() public {
        (uint256 r2, DrillBeacon beacon,,) = _addRouteWithBeacon();
        assertEq(cycle(address(this), address(beacon), abi.encodeCall(DrillBeacon.fire, (r2 + 5))).length, 0);
        (bool paused,,,,,,) = rsc.routeState(r2);
        assertFalse(paused);
    }

    function test_addRoute_requires_proxies() public {
        LedgerlockReactive fresh = new LedgerlockReactive();
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.ProxyUnset.selector, UNI));
        fresh.addRoute(_routeA(address(box), address(minter), address(gateB), address(gateU), address(0)), _t0A());
    }

    function test_live_entry_behind_cleared_head_overdue_then_resolve_consumes() public {
        feed(_L(20, bob, 1e18)); // keys up to 36 plausible
        feed(_M(21, alice, 1e18)); // A
        feed(_M(22, alice, 2e18)); // B
        feed(_L(21, alice, 1e18)); // A matched: B still pending, gates stay shut
        assertFalse(gateU.isOpen());
        vm.warp(block.timestamp + W + 1);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.OVERDUE, 1);
        feed(_L(23, bob, 1e18)); // any route event: the walk passes A's cleared slot and finds B overdue
        assertEq(rsc.getState(R).qHead, 1); // head moved past A only
        rsc.resolve(R, 1, true);
        (,, bool consumed,, uint256 pendAmt,) = _slot(0, 22);
        assertTrue(consumed);
        assertEq(pendAmt, 0);
        assertEq(rsc.getState(R).qHead, rsc.pendingQueue(R).length);
    }

    function test_key_beyond_uint128_latches_without_queueing() public {
        assertEq(feed(_M(uint256(type(uint128).max) + 1, thief, 1e18)).length, 2);
        (, bool incident,,, uint32 pending,,) = rsc.routeState(R);
        assertTrue(incident);
        assertEq(pending, 0);
    }

    // ================================================================== helpers

    function feed(IReactive.LogRecord memory rec) internal returns (CallbackResult[] memory) {
        IReactive.LogRecord[] memory recs = new IReactive.LogRecord[](1);
        recs[0] = rec;
        return _drain(recs);
    }

    // ================================================================== a2a round 03 (arch) regressions

    /// A pause leg that went GateUnreachable is asked again on the next mismatch (it used to stay open for good).
    function test_a2a_failed_pause_leg_resent_on_next_mismatch() public {
        gateU.setFailNext(true); // silent indebted gate
        _mintTx(1, alice, 1e18);
        vm.warp(block.timestamp + 31);
        cron(CronTopics.CRON10);
        vm.warp(block.timestamp + 31);
        cron(CronTopics.CRON10); // GateUnreachable(U) + FAILSAFE
        assertTrue(gateU.isOpen());
        assertFalse(gateB.isOpen());
        gateU.setFailNext(false);
        CallbackResult[] memory r = _mintTx(2, bob, 1e18); // lands through the open gate; a new pause epoch to both
        assertEq(r.length, 2);
        assertAllSucceeded(r);
        assertEq(rsc.getState(R).epoch, 2);
        assertFalse(gateU.isOpen());
        assertEq(rsc.outstandingAcks(), 0);
        assertFalse(rsc.cronOn());
    }

    /// A late failure of an exhausted cycle (older epoch) never spends the re-armed cycle's retry budget (a2a round 4).
    function test_a2a_stale_failure_of_exhausted_cycle_ignored() public {
        deliver(_M(1, alice, 1e18)); // plausible pause, epoch 1
        sys.takeRequests();
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1)); // retry
        sys.takeRequests();
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1)); // GateUnreachable(U)
        deliver(_M(2, bob, 1e18)); // new mismatch: new epoch 2 to both gates
        assertEq(sys.takeRequests().length, 2);
        deliver(_fail(UNI, address(gateU), PAUSE_SEL, 1)); // late failure of the exhausted epoch-1 cycle
        (bool owed,, uint64 e,,, bool failRetried,,,) = rsc.acks(R, 0);
        assertTrue(owed);
        assertEq(e, 2);
        assertFalse(failRetried);
        assertEq(sys.takeRequests().length, 0);
    }

    /// Amounts that do not fit never revert react() before the pause (a revert = no pause) (a2a round 4).
    function test_a2a_accumulator_overflow_pauses_instead_of_reverting() public {
        deliver(_M(1_000_000, thief, type(uint256).max)); // forged: pause + REPEAT
        deliver(_M(1_000_001, thief, 1)); // unbacked would overflow: reverted before the fix
        (bool paused, bool incident,,,,,) = rsc.routeState(R);
        assertTrue(paused && incident);
        (uint256 r2, address col,) = _addSupplyRoute();
        deliver(_log(BASE, col, SENT_T0, UNI, uint160(bob), abi.encode(type(uint256).max)));
        deliver(_log(BASE, col, SENT_T0, UNI, uint160(bob), abi.encode(uint256(1)))); // lockedTotal would overflow
        (paused, incident,,,,,) = rsc.routeState(r2);
        assertTrue(paused && incident);
        assertEq(uint8(rsc.getState(r2).cause), uint8(LedgerlockReactive.Cause.SUPPLY));
        // a saturated source total hides any deficit, so it counts as one: reopening needs acceptDeficit, which rebases it
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, type(uint256).max, uint256(0)));
        rsc.resolve(r2, 1, false);
        rsc.resolve(r2, 1, true);
        assertEq(rsc.getState(r2).lockedTotal, rsc.getState(r2).mintedTotal);
        // NONCE: unbacked saturated + a release deficit: resolve() must not overflow on the sum
        deliver(_R(9_000_000, thief, 1e18));
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.Deficit.selector, type(uint256).max, uint256(1e18)));
        rsc.resolve(R, 1, false);
        rsc.resolve(R, 1, true);
    }

    /// Normal path: with both gates acked, a copycat and a resolve() on a healthy route send nothing extra.
    function test_a2a_no_resend_when_gates_confirmed() public {
        feed(_M(1_000_000, thief, 1e18)); // forged: pause epoch 1, both acks back
        assertEq(rsc.outstandingAcks(), 0);
        deliver(_M(1_000_001, thief, 1e18)); // copycat while paused and confirmed
        assertEq(sys.takeRequests().length, 0);
        feed(_L(5, alice, 1e18));
        feed(_M(5, alice, 1e18)); // a matched legit pair needs no callback, paused or not
        assertEq(sys.takeRequests().length, 0);
        deliver(_seized(thief, 2e18)); // remediate both forged mints so resolve() passes the deficit check
        rsc.resolve(R, 1, false);
        runCallbacks(); // resume epoch 2 to both gates
        assertEq(sys.takeRequests().length, 0);
        rsc.resolve(R, 1, false); // healthy, unpaused, both gates acked at epoch 2: nothing to send
        assertEq(sys.takeRequests().length, 0);
    }

    /// A resume that went GateUnreachable left that gate shut; the owner's resolve() sends it again.
    function test_a2a_failed_resume_resent_by_resolve() public {
        feed(_M(3, alice, 1e18));
        gateU.setFailNext(true);
        feed(_L(3, alice, 1e18));
        deliver(_fail(UNI, address(gateU), RESUME_SEL, 2));
        runCallbacks();
        deliver(_fail(UNI, address(gateU), RESUME_SEL, 2)); // GateUnreachable(U)
        assertFalse(gateU.isOpen());
        (bool paused,,,,,,) = rsc.routeState(R);
        assertFalse(paused);
        gateU.setFailNext(false);
        rsc.resolve(R, 1, false);
        runCallbacks();
        assertTrue(gateU.isOpen());
        assertTrue(gateB.isOpen());
    }

    /// Any reactive contract can make the proxy fail a callback to our gate; such failures never touch our retry budget.
    function test_a2a_spoofed_callback_failure_ignored() public {
        deliver(_M(1, alice, 1e18)); // plausible pause, epoch 1
        sys.takeRequests();
        bytes[3] memory spoofs = [
            abi.encodeWithSelector(PAUSE_SEL, address(0xE11), R, uint64(1), bytes32(0), uint256(0)), // foreign requester
            abi.encodeWithSelector(PAUSE_SEL, address(rsc), uint256(9), uint64(1), bytes32(0), uint256(0)), // other route
            abi.encodeWithSelector(RESUME_SEL, address(rsc), R, uint64(1), bytes32(0), uint256(0)) // other op
        ];
        for (uint256 i; i < 3; i++) {
            IReactive.LogRecord memory f = _fail(UNI, address(gateU), PAUSE_SEL, 1);
            f.data = abi.encode(spoofs[i]);
            deliver(f);
            deliver(f); // same log again: deduped
        }
        assertEq(sys.takeRequests().length, 0);
        (bool owed,,,,, bool failRetried,,,) = rsc.acks(R, 0);
        assertTrue(owed);
        assertFalse(failRetried);
        (, bool incident,,,,,) = rsc.routeState(R);
        assertFalse(incident);
    }

    /// A source key near uint256 max cannot make the plausibility check overflow (a reverting react() = no pause).
    function test_a2a_plausibility_check_cannot_overflow() public {
        deliver(_L(type(uint256).max, alice, 1e18));
        deliver(_M(5, bob, 1e18)); // reverted before the fix
        (bool paused,,,, uint32 pending,,) = rsc.routeState(R);
        assertTrue(paused);
        assertEq(pending, 1);
    }

    function test_a2a_duplicate_binding_reverts() public {
        vm.expectRevert(LedgerlockReactive.BadRoute.selector);
        rsc.addRoute(_routeA(address(box), address(minter), address(gateB), address(gateU), address(0)), _t0A());
    }

    function test_a2a_ack_naming_another_route_ignored() public {
        deliver(_M(1, alice, 1e18));
        sys.takeRequests();
        IReactive.LogRecord memory a = _ack(UNI, address(gateU), 1);
        a.topic1 = 7;
        deliver(a);
        (bool owed,,,,,,,,) = rsc.acks(R, 0);
        assertTrue(owed);
    }

    function test_a2a_set_proxy_once() public {
        vm.expectRevert(abi.encodeWithSelector(LedgerlockReactive.ProxySet.selector, BASE));
        rsc.setProxy(BASE, address(0x1234));
    }

    /// A lock whose fields contradict the mint waiting on its key latches at once (it used to wait for OVERDUE).
    function test_a2a_contradicting_lock_latches_now() public {
        deliver(_M(4, alice, 1e18)); // plausible: pending, epoch 1
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.IncidentLatched(R, LedgerlockReactive.Cause.REPEAT, 1);
        deliver(_L(4, alice, 2e18));
        (bool paused, bool incident,,, uint32 pending,,) = rsc.routeState(R);
        assertTrue(paused && incident);
        assertEq(pending, 1);
    }

    function _settle() internal {
        _drain(new IReactive.LogRecord[](0));
    }

    function _lock(address to, uint256 amt) internal returns (CallbackResult[] memory) {
        return cycle(alice, address(box), abi.encodeCall(LockBox.lock, (to, amt)));
    }

    function _mintTx(uint64 n, address to, uint256 amt) internal returns (CallbackResult[] memory) {
        return cycle(relayer, address(minter), abi.encodeCall(Minter.mint, (n, to, amt)));
    }

    function _log(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, bytes memory data)
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
            data: data,
            blockNumber: block.number,
            opCode: 3,
            blockHash: 0,
            txHash: uint256(keccak256(abi.encode("log", ++txn))),
            logIndex: 0
        });
    }

    function _L(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(BASE, address(box), LOCKED_T0, n, uint160(to), abi.encode(amt));
    }

    function _M(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(UNI, address(minter), MINTED_T0, n, uint160(to), abi.encode(amt));
    }

    function _B(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(UNI, address(minter), BURNED_T0, n, uint160(to), abi.encode(amt));
    }

    function _R(uint256 n, address to, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(BASE, address(box), RELEASED_T0, n, uint160(to), abi.encode(amt));
    }

    function _seized(address holder, uint256 amt) internal returns (IReactive.LogRecord memory) {
        return _log(UNI, address(minter), SEIZED_T0, uint160(holder), 0, abi.encode(amt));
    }

    function _ack(uint256 chainId, address gate, uint64 e) internal returns (IReactive.LogRecord memory) {
        return _log(chainId, gate, uint256(keccak256("Paused(uint256,uint64,bytes32,uint256)")), R, 0, abi.encode(e, 0));
    }

    /// @dev The proxy's CallbackFailure(target, payload) as measured: payload = full calldata, word 0 = requesting RSC.
    function _fail(uint256 chainId, address gate, bytes4 sel, uint64 e) internal returns (IReactive.LogRecord memory) {
        bytes memory payload = abi.encodeWithSelector(sel, address(rsc), R, e, bytes32(0), uint256(0));
        return _log(chainId, chainId == UNI ? PROXY_U : PROXY_B, CF_T0, uint160(gate), 0, abi.encode(payload));
    }

    function _decode(bytes memory p)
        internal
        pure
        returns (bytes4 sel, uint256 route, uint64 e, bytes32 origin, uint256 key)
    {
        sel = bytes4(p);
        bytes memory args = new bytes(p.length - 4);
        for (uint256 i; i < args.length; i++) {
            args[i] = p[i + 4];
        }
        (, route, e, origin, key) = abi.decode(args, (address, uint256, uint64, bytes32, uint256));
    }

    function _slot(uint8 dir, uint256 key)
        internal
        view
        returns (uint256 srcAmt, bool srcSeen, bool consumed, uint64 since, uint256 pendAmt, address pendTo)
    {
        address srcTo;
        (srcAmt, srcTo, srcSeen, consumed, since, pendAmt, pendTo) = rsc.slots(R, dir, key);
    }

    function _assertOpen(uint256 r, uint256 wantUnbacked) internal view {
        (bool paused, bool incident,,, uint32 pending, uint256 unbacked,) = rsc.routeState(r);
        assertFalse(paused, "paused");
        assertFalse(incident, "incident");
        assertEq(pending, 0, "pending");
        assertEq(unbacked, wantUnbacked, "unbacked");
    }

    function _addRouteWithBeacon() internal returns (uint256 r2, DrillBeacon beacon, Gate gb2, Gate gu2) {
        beacon = new DrillBeacon();
        gb2 = new Gate(address(proxy), address(rsc), address(this));
        gu2 = new Gate(address(proxy), address(rsc), address(this));
        onChain(address(beacon), BASE);
        onChain(address(gb2), BASE);
        onChain(address(gu2), UNI);
        r2 = rsc.addRoute(
            _routeA(makeAddr("lbB"), makeAddr("mtB"), address(gb2), address(gu2), address(beacon)), _t0A()
        );
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
}
