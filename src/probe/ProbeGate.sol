// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Gate} from "../Gate.sol";

/// @title ProbeGate
/// @notice Dev-deployment gate with a one-shot `failNext` flag, used once to force a real callback failure on each
///         destination proxy and record the proxy's `CallbackFailure` log (emitter, topic0, payload). Not the gate the
///         final deployment uses.
contract ProbeGate is Gate {
    bool public failNext;

    error ProbeFail(uint64 lastEpoch);

    constructor(address callbackProxy_, address rsc_, address guardian_)
        payable
        Gate(callbackProxy_, rsc_, guardian_)
    {}

    function setFailNext(bool v) external onlyGuardian {
        failNext = v;
    }

    function _beforeCallback() internal view override {
        if (failNext) {
            // A revert also rolls back this write, so the flag stays set until the guardian clears it.
            revert ProbeFail(lastEpoch);
        }
    }
}
