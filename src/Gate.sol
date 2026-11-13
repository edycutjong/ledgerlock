// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";

/// @notice The pause surface of an existing bridge component (e.g. Hyperlane's `PausableIsm`, OpenZeppelin `Pausable`).
interface IPausable {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}

/// @title Gate
/// @notice The pause switch Ledgerlock flips on one chain of a route (same bytecode on Base and Unichain Sepolia).
///         Only the Reactive callback proxy may call `pause`/`resume`, and only with the authorised reactive contract
///         as the injected first argument. The origin tx hash travels in every callback and every gate event.
/// @dev Epoch rule: an older epoch never undoes a newer one (`StaleEpoch`). The same epoch with the same operation (a
///      re-request after a lost ack log or a failed delivery) re-emits its ack without a state change; the same epoch
///      with the other operation is stale. A guardian pause cannot be lifted by an automated resume (`HeldByGuardian`);
///      only `guardianResume()` clears it. With a `target` set, the gate also moves it, but only when its state differs
///      (OpenZeppelin `Pausable` reverts on a repeated pause/unpause, which would turn a guardian's earlier action into a
///      failing callback and a false FAILSAFE).
contract Gate is AbstractCallback {
    uint8 internal constant OP_PAUSE = 1;
    uint8 internal constant OP_RESUME = 2;

    bool public paused;
    bool public guardianHeld;
    uint64 public lastEpoch;
    uint8 public lastOp;
    address public guardian;
    IPausable public target;

    event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event Resumed(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key);
    event StaleEpoch(uint64 epoch, uint64 lastEpoch);
    event HeldByGuardian(uint256 indexed routeId, uint64 epoch);
    event GuardianSet(address guardian);
    event TargetSet(address target);
    event GuardianAction(bool paused);

    error NotGuardian();
    error TargetAlreadySet();

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

    /// @notice Bind the bridge component this gate pauses (once). The gate must own it.
    function setTarget(address target_) external onlyGuardian {
        if (address(target) != address(0)) revert TargetAlreadySet();
        target = IPausable(target_);
        emit TargetSet(target_);
    }

    /// @notice Callback: shut the gate. `rvm` is injected by the proxy (the requesting reactive contract).
    function pause(address rvm, uint256 routeId, uint64 epoch, bytes32 originTx, uint256 key)
        external
        virtual
        onlyServiceProvider
        onlyCallbackSender(rvm)
    {
        _beforeCallback();
        if (!_fresh(epoch, OP_PAUSE)) return;
        paused = true;
        _moveTarget(true);
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
        if (!_fresh(epoch, OP_RESUME)) return;
        if (guardianHeld) {
            emit HeldByGuardian(routeId, epoch);
            return;
        }
        paused = false;
        _moveTarget(false);
        emit Resumed(routeId, epoch, originTx, key);
    }

    /// @dev true = apply (new epoch, or the same epoch + op re-requested: re-applying is a no-op and re-emits the ack).
    function _fresh(uint64 epoch, uint8 op) internal returns (bool) {
        if (epoch < lastEpoch || (epoch == lastEpoch && op != lastOp)) {
            emit StaleEpoch(epoch, lastEpoch);
            return false;
        }
        lastEpoch = epoch;
        lastOp = op;
        return true;
    }

    function _moveTarget(bool toPaused) internal {
        IPausable t = target;
        if (address(t) == address(0)) return;
        if (t.paused() == toPaused) return;
        if (toPaused) t.pause();
        else t.unpause();
    }

    function guardianPause() external onlyGuardian {
        guardianHeld = true;
        paused = true;
        _moveTarget(true);
        emit GuardianAction(true);
    }

    /// @notice Lift the guardian's hold. The gate returns to the reactive contract's last decision: a guardian can
    ///         never lift an automated pause (that is `resolve()` on the reactive contract).
    function guardianResume() external onlyGuardian {
        guardianHeld = false;
        bool rscPaused = lastOp == OP_PAUSE;
        paused = rscPaused;
        _moveTarget(rscPaused);
        emit GuardianAction(rscPaused);
    }

    function isOpen() external view returns (bool) {
        return !paused;
    }

    /// @dev Hook for probe subclasses (forced failure). Production gates do nothing here.
    function _beforeCallback() internal virtual {}
}
