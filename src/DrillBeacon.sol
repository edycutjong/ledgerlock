// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title DrillBeacon
/// @notice A labelled operator drill: the owner fires `Drill(routeId)` on the source chain, and the guard's `react()`
///         pauses both gates through the real callback path (origin -> Lasna -> two callbacks), then latches DRILL until
///         the owner's `resolve()`. Used on route B, where no attack is staged.
contract DrillBeacon {
    address public immutable owner;

    event Drill(uint256 indexed routeId);

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function fire(uint256 routeId) external {
        if (msg.sender != owner) revert NotOwner();
        emit Drill(routeId);
    }
}
