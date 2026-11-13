// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {OmniReactiveTest} from "reactive-kit/test/OmniReactiveTest.sol";
import {CallbackResult} from "reactive-test-lib/interfaces/IReactiveInterfaces.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {LedgerlockReactive} from "../src/LedgerlockReactive.sol";
import {Gate} from "../src/Gate.sol";
import {ProbeGate} from "../src/probe/ProbeGate.sol";
import {LockBox} from "../src/fixture/LockBox.sol";
import {Minter} from "../src/fixture/Minter.sol";
import {CronTopics} from "reactive-kit/CronTopics.sol";

contract LedgerlockReactiveTest is OmniReactiveTest {
    uint256 constant BASE = 84532;
    uint256 constant UNI = 1301;

    LedgerlockReactive rsc;
    ProbeGate gateB;
    ProbeGate gateU;
    LockBox box;
    Minter minter;
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");

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
        rsc.init(BASE, address(box), address(gateB), UNI, address(minter), address(gateU));
    }

    function _lock(address to, uint256 amt) internal returns (CallbackResult[] memory) {
        return cycle(alice, address(box), abi.encodeCall(LockBox.lock, (to, amt)));
    }

    function _mint(uint64 n, address to, uint256 amt) internal returns (CallbackResult[] memory) {
        return cycle(relayer, address(minter), abi.encodeCall(Minter.mint, (n, to, amt)));
    }

    function test_init_subscribes_six_topics() public view {
        assertEq(sys.activeSubscriptions(address(rsc)), 6);
    }

    function test_lock_then_matching_mint_costs_no_callback() public {
        assertCallbacks(_lock(alice, 100e18), 0);
        assertCallbacks(_mint(1, alice, 100e18), 0);
        assertTrue(rsc.minted(1));
        assertFalse(rsc.paused());
        assertEq(rsc.unbacked(), 0);
    }

    function test_unmatched_mint_pauses_both_chains_in_one_react() public {
        CallbackResult[] memory r = _mint(1000, mallory, 500e18);
        assertCallbacks(r, 2);
        assertAllSucceeded(r);
        assertEq(r[0].chainId, UNI, "mint side first");
        assertEq(r[1].chainId, BASE);
        assertTrue(gateU.paused());
        assertTrue(gateB.paused());
        assertTrue(rsc.paused());
        assertEq(rsc.unbacked(), 500e18);
        assertEq(rsc.pendingCount(), 1);
    }

    function test_copycat_mint_blocked_by_gate_after_pause() public {
        _mint(1000, mallory, 500e18);
        vm.prank(relayer);
        vm.expectRevert(Minter.GatePaused.selector);
        minter.mint(1001, mallory, 500e18);
    }

    function test_second_unmatched_mint_does_not_rebill_callbacks() public {
        _mint(1000, mallory, 1e18);
        // gate shut: a second mint can only reach the RSC as a log; deliver one directly
        IReactive.LogRecord memory log_ = _mintedLog(1001, mallory, 1e18, 77);
        deliver(log_);
        (CallbackResult[] memory r,) = runCallbacks();
        assertEq(r.length, 0);
        assertEq(rsc.pendingCount(), 2);
    }

    function test_mint_before_lock_auto_resumes_on_matching_lock() public {
        assertCallbacks(_mint(1, alice, 100e18), 2); // fill-before-deposit: pause first
        assertTrue(gateU.paused());
        vm.warp(block.timestamp + 5);
        CallbackResult[] memory r = _lock(alice, 100e18); // nonce 1 arrives
        assertCallbacks(r, 2);
        assertAllSucceeded(r);
        assertFalse(gateU.paused());
        assertFalse(gateB.paused());
        assertFalse(rsc.paused());
        assertEq(rsc.unbacked(), 0);
        assertEq(rsc.pendingCount(), 0);
        assertEq(gateU.lastEpoch(), 3);
    }

    function test_lock_with_other_recipient_does_not_resume() public {
        _mint(1, mallory, 100e18);
        assertCallbacks(_lock(alice, 100e18), 0);
        assertTrue(gateU.paused());
        assertEq(rsc.pendingCount(), 1);
    }

    function test_duplicate_delivery_is_noop() public {
        IReactive.LogRecord memory log_ = _mintedLog(1000, mallory, 1e18, 9);
        deliver(log_);
        deliver(log_);
        (CallbackResult[] memory r,) = runCallbacks();
        assertEq(r.length, 2);
        assertEq(rsc.unbacked(), 1e18);
    }

    function test_resolve_clears_pending_and_resumes() public {
        _mint(1000, mallory, 500e18);
        uint256[] memory keys = new uint256[](1);
        keys[0] = 1000;
        vm.recordLogs();
        rsc.resolve(keys);
        (CallbackResult[] memory r,) = runCallbacks();
        assertEq(r.length, 2);
        assertAllSucceeded(r);
        assertFalse(gateU.paused());
        assertFalse(gateB.paused());
        assertEq(rsc.unbacked(), 0);
        assertEq(rsc.pendingCount(), 0);
    }

    function test_resolve_only_owner() public {
        uint256[] memory keys = new uint256[](0);
        vm.prank(mallory);
        vm.expectRevert(LedgerlockReactive.NotOwner.selector);
        rsc.resolve(keys);
    }

    function test_react_only_system() public {
        IReactive.LogRecord memory log_ = _mintedLog(1000, mallory, 1e18, 1);
        vm.expectRevert();
        rsc.react(log_);
    }

    function test_unrelated_gate_ack_ignored() public {
        IReactive.LogRecord memory log_ = _mintedLog(1, alice, 1, 3);
        log_.topic0 = uint256(keccak256("Paused(uint256,uint64,bytes32,uint256)"));
        log_.contractAddress = address(0xBEEF);
        log_.data = abi.encode(uint64(9), uint256(0));
        vm.recordLogs();
        deliver(log_); // no subscriber matches 0xBEEF -> nothing happens
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // ------------------------------------------------------------------ gate

    function test_gate_rejects_wrong_injected_sender() public {
        injectOverride = mallory;
        CallbackResult[] memory r = _mint(1000, mallory, 1e18);
        assertEq(r.length, 2);
        assertFalse(r[0].success);
        assertFalse(gateU.paused());
    }

    function test_gate_rejects_direct_call() public {
        vm.expectRevert();
        gateU.pause(address(rsc), 1, 5, bytes32(0), 0);
    }

    function test_gate_stale_epoch_ignored() public {
        vm.prank(address(proxy));
        gateU.pause(address(rsc), 1, 5, bytes32(uint256(1)), 0);
        vm.prank(address(proxy));
        vm.expectEmit(address(gateU));
        emit Gate.StaleEpoch(4, 5);
        gateU.resume(address(rsc), 1, 4, bytes32(uint256(2)), 0);
        assertTrue(gateU.paused());
    }

    function test_guardian_hold_survives_rsc_resume() public {
        gateU.guardianPause();
        vm.prank(address(proxy));
        gateU.resume(address(rsc), 1, 2, bytes32(0), 0);
        assertTrue(gateU.paused());
        gateU.guardianResume();
        assertFalse(gateU.paused());
    }

    function test_probe_gate_fail_next_makes_callback_fail() public {
        gateU.setFailNext(true);
        gateB.setFailNext(true);
        CallbackResult[] memory r = _mint(1000, mallory, 1e18);
        assertEq(r.length, 2);
        assertFalse(r[0].success);
        assertFalse(r[1].success);
        assertEq(bytes4(r[0].returnData), ProbeGate.ProbeFail.selector);
        assertFalse(gateU.paused());
    }

    // ------------------------------------------------------------------ fixture

    function test_fixture_caps_and_relayer_only() public {
        vm.expectRevert(LockBox.OverCap.selector);
        box.lock(alice, 501e18);
        vm.expectRevert(Minter.NotRelayer.selector);
        minter.mint(1, alice, 1);
        vm.prank(relayer);
        minter.mint(1, alice, 1);
        vm.prank(relayer);
        vm.expectRevert(Minter.NonceUsed.selector);
        minter.mint(1, alice, 1);
    }

    function test_release_blocked_while_gate_b_paused() public {
        _mint(1000, mallory, 1e18);
        vm.prank(relayer);
        vm.expectRevert(LockBox.GatePaused.selector);
        box.releaseByRelayer(1, mallory, 1e18);
    }

    // ------------------------------------------------------------------ probes

    function test_cron_probe_subscribes_from_react_and_unsubscribes_on_tick() public {
        rsc.armCronProbe();
        _mint(1000, mallory, 1e18); // acks arrive -> subscribe
        assertEq(rsc.cronProbe(), 2);
        assertEq(sys.activeSubscriptions(address(rsc)), 7);
        cron(CronTopics.CRON10);
        assertEq(rsc.cronProbe(), 3);
        assertEq(sys.activeSubscriptions(address(rsc)), 6);
    }

    function test_hop_marks_only_system_plus_self_authorised() public {
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.HopSeen(1, mallory, address(rsc), false);
        vm.prank(mallory);
        rsc.hop(address(rsc), 1);
        vm.expectEmit(address(rsc));
        emit LedgerlockReactive.HopSeen(2, SYSTEM_ADDR, address(rsc), true);
        vm.prank(SYSTEM_ADDR);
        rsc.hop(address(rsc), 2);
    }

    function test_probe_hop_requests_self_callback() public {
        rsc.probeHop();
        (CallbackResult[] memory r,) = runCallbacks();
        assertEq(r.length, 1);
        assertEq(r[0].chainId, block.chainid);
        assertEq(r[0].target, address(rsc));
    }

    // ------------------------------------------------------------------ helpers

    function _mintedLog(uint64 n, address to, uint256 amt, uint256 txh) internal view returns (IReactive.LogRecord memory) {
        return IReactive.LogRecord({
            chainId: UNI,
            contractAddress: address(minter),
            topic0: uint256(keccak256("Minted(uint64,address,uint256)")),
            topic1: n,
            topic2: uint256(uint160(to)),
            topic3: 0,
            data: abi.encode(amt),
            blockNumber: block.number,
            opCode: 3,
            blockHash: 0,
            txHash: txh,
            logIndex: 0
        });
    }
}
