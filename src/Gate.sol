// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";

/// @title Gate
/// @notice The pause switch Ledgerlock flips on one chain of a route (same bytecode on Base and Unichain Sepolia).
///         Only the Reactive callback proxy may call `pause`/`resume`, and only with the authorised reactive contract
///         as the injected first argument. The origin tx hash travels in every callback and every gate event.
/// @dev Epoch rule: an older epoch never undoes a newer one (`StaleEpoch`). A repeated callback with the same epoch
///      re-emits its ack, so a lost ack log can be regenerated; the RSC bumps the epoch on every pause/resume flip, so
///      one epoch never carries both operations (strict same-op idempotence arrives with the core flow). A guardian pause cannot be lifted by
///      an automated resume (`HeldByGuardian`); only `guardianResume()` clears it.
contract Gate is AbstractCallback {
    bool public paused;
    bool public guardianHeld;
    uint64 public lastEpoch;
    address public guardian;

    event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event Resumed(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event StaleEpoch(uint64 epoch, uint64 lastEpoch);
    event HeldByGuardian(uint256 indexed routeId, uint64 epoch);
    event GuardianSet(address guardian);

    error NotGuardian();

    constructor(address callbackProxy_, address rsc_, address guardian_)
        payable
        AbstractCallback(IPayable(payable(callbackProxy_)), rsc_)
    {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @notice Callback: shut the gate. `rvm` is injected by the proxy (the requesting reactive contract).
    function pause(address rvm, uint256 routeId, uint64 epoch, bytes32 originTx, uint256 key)
        external
        virtual
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        _beforeCallback();
        if (epoch < lastEpoch) {
            emit StaleEpoch(epoch, lastEpoch);
            return;
        }
        lastEpoch = epoch;
        paused = true;
        emit Paused(routeId, epoch, originTx, key);
    }

    /// @notice Callback: reopen the gate, unless a newer epoch exists or the guardian holds it.
    function resume(address rvm, uint256 routeId, uint64 epoch, bytes32 originTx, uint256 key)
        external
        virtual
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        _beforeCallback();
        if (epoch < lastEpoch) {
            emit StaleEpoch(epoch, lastEpoch);
            return;
        }
        lastEpoch = epoch;
        if (guardianHeld) {
            emit HeldByGuardian(routeId, epoch);
            return;
        }
        paused = false;
        emit Resumed(routeId, epoch, originTx, key);
    }

    function guardianPause() external onlyGuardian {
        guardianHeld = true;
        paused = true;
    }

    function guardianResume() external onlyGuardian {
        guardianHeld = false;
        paused = false;
    }

    function isOpen() external view returns (bool) {
        return !paused;
    }

    /// @dev Hook for probe subclasses (forced failure). Production gates do nothing here.
    function _beforeCallback() internal virtual {}
}
