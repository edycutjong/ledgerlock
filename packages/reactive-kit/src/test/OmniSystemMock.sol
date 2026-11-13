// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";

/// @title OmniSystemMock
/// @notice Local stand-in for the Omni system contract (0x8888…8888): subscriptions with the documented wildcard
///         semantics (chain 0 / contract 0 / REACTIVE_IGNORE = any) and a queue of `requestCallbackV_1_0` requests.
/// @dev Why this exists: reactive-test-lib (pinned 2ff9b2a) mocks the LEGACY system address 0x…fffFfF, delivers
///      `react()` from it and parses the legacy `Callback` event. Omni contracts accept `react()` only from 0x8888…8888
///      and request callbacks through SYSTEM, so the Test Lib simulator cannot drive them unmodified. This mock is
///      etched at 0x8888…8888 by `OmniReactiveTest`; callback delivery reuses the Test Lib's MockCallbackProxy.
contract OmniSystemMock {
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    struct Sub {
        uint256 chainId;
        address contractAddr;
        uint256 t0;
        uint256 t1;
        uint256 t2;
        uint256 t3;
        address subscriber;
        bool active;
    }

    struct Request {
        address requester;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Sub[] internal subs;
    Request[] internal queue;
    uint256 public callbackRequests;

    event Subscribed(address indexed subscriber, uint256 chainId, address contractAddr, uint256 t0, uint256 t1);
    event Unsubscribed(address indexed subscriber, uint256 chainId, address contractAddr, uint256 t0, uint256 t1);
    event CallbackRequested(address indexed requester, uint256 indexed chainId, address indexed recipient, uint64 gasLimit);

    error NoSpecificCriterion();

    function subscribe(uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        // docs: at least one criterion must be specific
        if (
            chainId == 0 && c == address(0) && t0 == REACTIVE_IGNORE && t1 == REACTIVE_IGNORE && t2 == REACTIVE_IGNORE
                && t3 == REACTIVE_IGNORE
        ) revert NoSpecificCriterion();
        subs.push(Sub(chainId, c, t0, t1, t2, t3, msg.sender, true));
        emit Subscribed(msg.sender, chainId, c, t0, t1);
    }

    /// @notice Removes every active subscription of the caller with exactly these criteria.
    function unsubscribe(uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        for (uint256 i; i < subs.length; i++) {
            Sub storage s = subs[i];
            if (
                s.active && s.subscriber == msg.sender && s.chainId == chainId && s.contractAddr == c && s.t0 == t0
                    && s.t1 == t1 && s.t2 == t2 && s.t3 == t3
            ) s.active = false;
        }
        emit Unsubscribed(msg.sender, chainId, c, t0, t1);
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external { // forge-lint: disable-line(mixed-case-function)
        _enqueue(c);
    }

    function requestCallback(ISystemContract.CallbackVersion, bytes memory config) external {
        _enqueue(abi.decode(config, (ISystemContract.CallbackConfiguration_V_1_0)));
    }

    function _enqueue(ISystemContract.CallbackConfiguration_V_1_0 memory c) internal {
        queue.push(Request(msg.sender, c.chainId, c.recipient, c.gasLimit, c.payload));
        callbackRequests++;
        emit CallbackRequested(msg.sender, c.chainId, c.recipient, c.gasLimit);
    }

    /// @notice Returns and clears the pending callback requests (harness only).
    function takeRequests() external returns (Request[] memory out) {
        out = queue;
        delete queue;
    }

    /// @notice Active subscribers whose criteria match a log (one entry per matching subscription).
    function matching(uint256 chainId, address emitter, uint256 t0, uint256 t1, uint256 t2, uint256 t3)
        external
        view
        returns (address[] memory out)
    {
        uint256 n;
        address[] memory tmp = new address[](subs.length);
        for (uint256 i; i < subs.length; i++) {
            Sub storage s = subs[i];
            if (!s.active) continue;
            if (s.chainId != 0 && s.chainId != chainId) continue;
            if (s.contractAddr != address(0) && s.contractAddr != emitter) continue;
            if (!_t(s.t0, t0) || !_t(s.t1, t1) || !_t(s.t2, t2) || !_t(s.t3, t3)) continue;
            tmp[n++] = s.subscriber;
        }
        out = new address[](n);
        for (uint256 i; i < n; i++) {
            out[i] = tmp[i];
        }
    }

    function activeSubscriptions(address subscriber) external view returns (uint256 n) {
        for (uint256 i; i < subs.length; i++) {
            if (subs[i].active && subs[i].subscriber == subscriber) n++;
        }
    }

    function _t(uint256 want, uint256 got) internal pure returns (bool) {
        return want == REACTIVE_IGNORE || want == got;
    }

    // ---- IPayable surface used by AbstractPayer ----
    /// @dev Billing is not modelled: debt is always 0, so an underfunded contract still "succeeds" here. Reserve and
    ///      debt behaviour (no react() while debt > 0) must be checked on Lasna, not in this harness.
    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}
}
