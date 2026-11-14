// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Gate} from "../src/Gate.sol";
import {LockBox} from "../src/fixture/LockBox.sol";
import {Minter} from "../src/fixture/Minter.sol";

/// @title LockBox fixture: access control, replay guards and the solvency check on every collateral exit.
/// @dev The gate is a real `Gate` (open until its guardian pauses it); the reactive loop is not needed here.
contract LockBoxTest is Test {
    LockBox box;
    Gate gate;
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address thief = makeAddr("thief");

    function setUp() public {
        gate = new Gate(makeAddr("callbackProxy"), makeAddr("rsc"), address(this));
        box = new LockBox(address(gate), relayer);
    }

    function test_lockbox_seed_collateral_owner_only() public {
        vm.prank(thief);
        vm.expectRevert(LockBox.NotOwner.selector);
        box.seedCollateral(1000e18);
        assertEq(box.collateral(), 0);

        vm.expectEmit(address(box));
        emit LockBox.CollateralSeeded(1000e18);
        box.seedCollateral(1000e18);
        assertEq(box.collateral(), 1000e18);
    }

    function test_lockbox_release_rejects_non_relayer() public {
        box.seedCollateral(1000e18);
        vm.prank(thief);
        vm.expectRevert(LockBox.NotRelayer.selector);
        box.releaseByRelayer(1, thief, 100e18);
        assertEq(box.collateral(), 1000e18);
        assertFalse(box.released(1));
    }

    function test_lockbox_release_rejects_replayed_burn_nonce() public {
        box.seedCollateral(1000e18);
        vm.prank(relayer);
        box.releaseByRelayer(1, alice, 100e18);
        vm.prank(relayer);
        vm.expectRevert(LockBox.AlreadyReleased.selector);
        box.releaseByRelayer(1, alice, 100e18);
        assertEq(box.totalReleased(), 100e18);
        assertEq(box.collateral(), 900e18);
    }

    function test_lockbox_release_reverts_when_collateral_insufficient() public {
        box.seedCollateral(100e18);
        vm.prank(relayer);
        vm.expectRevert(LockBox.Insolvent.selector);
        box.releaseByRelayer(1, alice, 100e18 + 1);
        assertEq(box.collateral(), 100e18);
        assertFalse(box.released(1)); // the revert rolls back the nonce mark too
    }

    function test_lockbox_initialize_owner_only() public {
        vm.prank(thief);
        vm.expectRevert(LockBox.NotOwner.selector);
        box.initialize(bytes32(0));
        assertEq(box.confirmAt(bytes32(0)), 0);
        // without the owner's buggy initialize, an unproven message is still rejected
        vm.expectRevert(LockBox.NotProven.selector);
        box.process(abi.encode(uint64(1), thief, 1e18));
    }

    function test_lockbox_process_rejects_reprocessed_message() public {
        box.seedCollateral(1000e18);
        box.initialize(bytes32(0)); // the fixture's Nomad-class bug: every unproven message passes the root check
        bytes memory message = abi.encode(uint64(7), thief, 100e18);
        vm.prank(thief);
        box.process(message);
        assertTrue(box.processed(keccak256(message)));
        vm.prank(thief);
        vm.expectRevert(LockBox.AlreadyReleased.selector);
        box.process(message);
        assertEq(box.totalReleased(), 100e18);
    }
}

/// @title Minter fixture: the burn cap and the owner-only seize remedy.
contract MinterTest is Test {
    Minter minter;
    Gate gate;
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address thief = makeAddr("thief");

    function setUp() public {
        gate = new Gate(makeAddr("callbackProxy"), makeAddr("rsc"), address(this));
        minter = new Minter(address(gate), relayer);
    }

    function _mint(uint64 n, address to, uint256 amt) internal {
        vm.prank(relayer);
        minter.mint(n, to, amt);
    }

    function test_minter_burn_rejects_over_cap_even_with_balance() public {
        _mint(1, alice, 500e18);
        _mint(2, alice, 500e18);
        vm.prank(alice);
        vm.expectRevert(Minter.OverCap.selector);
        minter.burn(alice, 500e18 + 1);
        assertEq(minter.balanceOf(alice), 1000e18);
        assertEq(minter.burnNonce(), 0);
    }

    function test_minter_seize_owner_only() public {
        _mint(1, thief, 100e18);
        vm.prank(thief);
        vm.expectRevert(Minter.NotOwner.selector);
        minter.seize(thief, 100e18);
        assertEq(minter.balanceOf(thief), 100e18);
    }

    function test_minter_seize_rejects_more_than_holder_balance() public {
        _mint(1, thief, 100e18);
        vm.expectRevert(Minter.Insufficient.selector);
        minter.seize(thief, 100e18 + 1);
        assertEq(minter.balanceOf(thief), 100e18);

        vm.expectEmit(address(minter));
        emit Minter.Seized(thief, 100e18);
        minter.seize(thief, 100e18);
        assertEq(minter.balanceOf(thief), 0);
        assertEq(minter.totalSupply(), 0);
    }
}
