// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title CronTopics
/// @notice Real topic0 values of the Reactive Network CRON events and their emitter.
/// @dev Source: dev.reactive.network "Subscribing To CRON Events". The legacy system contract emits Cron events;
///      Omni contracts subscribe to them through SYSTEM with `SYSTEM.subscribe(block.chainid, LEGACY_SYSTEM_ADDR,
///      topic, IGNORE, IGNORE, IGNORE)`. Note: reactive-test-lib's ReactiveConstants ships placeholder CRON topics
///      that differ from these after the first 4 bytes; never mix the two.
library CronTopics {
    address internal constant LEGACY_SYSTEM_ADDR = 0x0000000000000000000000000000000000fffFfF;

    uint256 internal constant CRON1 = 0xf02d6ea5c22a71cffe930a4523fcb4f129be6c804db50e4202fb4e0b07ccb514;
    uint256 internal constant CRON10 = 0x04463f7c1651e6b9774d7f85c85bb94654e3c46ca79b0c16fb16d4183307b687;
    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 internal constant CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4;
    uint256 internal constant CRON10000 = 0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56;

    /// @notice Block interval of a CRON topic (0 if the topic is not a CRON topic).
    function interval(uint256 topic0) internal pure returns (uint256) {
        if (topic0 == CRON1) return 1;
        if (topic0 == CRON10) return 10;
        if (topic0 == CRON100) return 100;
        if (topic0 == CRON1000) return 1000;
        if (topic0 == CRON10000) return 10000;
        return 0;
    }

    function isCron(address emitter, uint256 topic0) internal pure returns (bool) {
        return emitter == LEGACY_SYSTEM_ADDR && interval(topic0) != 0;
    }
}
