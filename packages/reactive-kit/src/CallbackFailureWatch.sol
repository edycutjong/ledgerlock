// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";

/// @title CallbackFailureWatch
/// @notice Decode the callback proxy's `CallbackFailure` event so a reactive contract can resend immediately.
/// @dev Measured on Base Sepolia (2026-11-08, tx 0x8e4b4956…a55c): the event is emitted by the DESTINATION chain's
///      callback proxy as `CallbackFailure(address indexed target, bytes payload)`; `payload` is the full calldata
///      with the injected first argument already in place. Because `target` is indexed, a reactive contract can
///      subscribe to failures of its own destination only: `subscribe(destChain, proxy, TOPIC, target, IGNORE, IGNORE)`.
///      The proxy bills a failed callback in full, and state written by the reverting call is rolled back.
library CallbackFailureWatch {
    /// keccak256("CallbackFailure(address,bytes)")
    uint256 internal constant TOPIC = 0xc8313f695443128e273f1edfcec40b94b7deea8dfbeafd0043290d6601d999db;

    function isFailure(IReactive.LogRecord calldata log, uint256 destChainId, address proxy, address target)
        internal
        pure
        returns (bool)
    {
        return log.chainId == destChainId && log.contractAddress == proxy && log.topic0 == TOPIC
            && log.topic1 == uint256(uint160(target));
    }

    /// @notice The failed calldata (selector + args).
    function payload(IReactive.LogRecord calldata log) internal pure returns (bytes memory) {
        return abi.decode(log.data, (bytes));
    }

    /// @notice 4-byte selector and the n-th 32-byte argument word of a failed payload.
    function selectorOf(bytes memory p) internal pure returns (bytes4 sel) {
        if (p.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(p, 0x20))
        }
    }

    function argWord(bytes memory p, uint256 n) internal pure returns (uint256 w) {
        uint256 off = 4 + 32 * n;
        require(p.length >= off + 32, "CallbackFailureWatch: short payload");
        assembly {
            w := mload(add(add(p, 0x20), off))
        }
    }
}
