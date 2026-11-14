// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Gate} from "../src/Gate.sol";
import {ProbeGate} from "../src/probe/ProbeGate.sol";
import {DrillBeacon} from "../src/DrillBeacon.sol";

/// @dev Minimal pausable bridge component owned by the gate under test.
contract TargetStub {
    bool public paused;

    function pause() external {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }
}

/// @title Gate guardian surface: only the guardian acts, and the bound target can never be swapped.
contract GateTest is Test {
    Gate gate;
    address guardian = makeAddr("guardian");
    address thief = makeAddr("thief");

    function setUp() public {
        gate = new Gate(makeAddr("callbackProxy"), makeAddr("rsc"), guardian);
    }

    function test_gate_guardian_actions_reject_non_guardian() public {
        TargetStub stub = new TargetStub();
        vm.startPrank(thief);
        vm.expectRevert(Gate.NotGuardian.selector);
        gate.setTarget(address(stub));
        vm.expectRevert(Gate.NotGuardian.selector);
        gate.guardianPause();
        vm.expectRevert(Gate.NotGuardian.selector);
        gate.guardianResume();
        vm.stopPrank();
        assertEq(address(gate.target()), address(0));
        assertTrue(gate.isOpen());
        assertFalse(gate.guardianHeld());
    }

    function test_gate_target_binds_once() public {
        TargetStub first = new TargetStub();
        TargetStub second = new TargetStub();
        vm.prank(guardian);
        vm.expectEmit(address(gate));
        emit Gate.TargetSet(address(first));
        gate.setTarget(address(first));

        vm.prank(guardian);
        vm.expectRevert(Gate.TargetAlreadySet.selector);
        gate.setTarget(address(second));
        assertEq(address(gate.target()), address(first));

        vm.prank(guardian);
        gate.guardianPause(); // the gate moves the target it was bound to
        assertTrue(first.paused());
    }

    function test_probe_gate_fail_flag_guardian_only() public {
        ProbeGate probe = new ProbeGate(makeAddr("callbackProxy"), makeAddr("rsc"), guardian);
        vm.prank(thief);
        vm.expectRevert(Gate.NotGuardian.selector);
        probe.setFailNext(true);
        assertFalse(probe.failNext());
    }
}

/// @title DrillBeacon: only its owner can fire the labelled operator drill.
contract DrillBeaconTest is Test {
    DrillBeacon beacon;

    function setUp() public {
        beacon = new DrillBeacon();
    }

    function test_drill_beacon_fire_owner_only() public {
        vm.prank(makeAddr("thief"));
        vm.expectRevert(DrillBeacon.NotOwner.selector);
        beacon.fire(2);

        vm.expectEmit(address(beacon));
        emit DrillBeacon.Drill(2);
        beacon.fire(2);
    }
}
