// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ReactiveConstants} from "reactive-test-lib/constants/ReactiveConstants.sol";
import {CronTopics} from "../src/CronTopics.sol";
import {CallbackFailureWatch} from "../src/CallbackFailureWatch.sol";

contract CronTopicsTest is Test {
    function test_cron_topics_are_event_signature_hashes() public pure {
        assertEq(CronTopics.CRON1, uint256(keccak256("Cron1(uint256)")));
        assertEq(CronTopics.CRON10, uint256(keccak256("Cron10(uint256)")));
        assertEq(CronTopics.CRON100, uint256(keccak256("Cron100(uint256)")));
        assertEq(CronTopics.CRON1000, uint256(keccak256("Cron1000(uint256)")));
        assertEq(CronTopics.CRON10000, uint256(keccak256("Cron10000(uint256)")));
    }

    function test_cron_interval_maps_every_real_topic() public pure {
        assertEq(CronTopics.interval(CronTopics.CRON1), 1);
        assertEq(CronTopics.interval(CronTopics.CRON10), 10);
        assertEq(CronTopics.interval(CronTopics.CRON100), 100);
        assertEq(CronTopics.interval(CronTopics.CRON1000), 1000);
        assertEq(CronTopics.interval(CronTopics.CRON10000), 10000);
        assertEq(CronTopics.interval(uint256(keccak256("Transfer(address,address,uint256)"))), 0, "not a CRON topic");
    }

    function test_cron_interval_rejects_testlib_placeholder_topics() public pure {
        // reactive-test-lib's CRON constants share the first 4 bytes with the real topics; they must never count as CRON
        assertEq(CronTopics.interval(ReactiveConstants.CRON_TOPIC_1), 0);
        assertEq(CronTopics.interval(ReactiveConstants.CRON_TOPIC_10), 0);
        assertEq(CronTopics.interval(ReactiveConstants.CRON_TOPIC_100), 0);
        assertEq(CronTopics.interval(ReactiveConstants.CRON_TOPIC_1000), 0);
        assertEq(CronTopics.interval(ReactiveConstants.CRON_TOPIC_10000), 0);
    }

    function test_isCron_requires_legacy_emitter_and_cron_topic() public pure {
        assertTrue(CronTopics.isCron(CronTopics.LEGACY_SYSTEM_ADDR, CronTopics.CRON1));
        assertTrue(CronTopics.isCron(CronTopics.LEGACY_SYSTEM_ADDR, CronTopics.CRON10000));
        assertFalse(CronTopics.isCron(address(0xBEEF), CronTopics.CRON10), "a CRON topic from another emitter");
        assertFalse(CronTopics.isCron(CronTopics.LEGACY_SYSTEM_ADDR, 0), "the legacy emitter with a non-CRON topic");
    }
}

contract CallbackFailureWatchEdgesTest is Test {
    bytes4 constant PING = bytes4(keccak256("ping(address,uint256,uint256,uint256)"));

    function argWordOf(bytes memory p, uint256 n) external pure returns (uint256) {
        return CallbackFailureWatch.argWord(p, n);
    }

    function test_selectorOf_short_payload_is_zero_selector() public pure {
        assertEq(CallbackFailureWatch.selectorOf(""), bytes4(0));
        assertEq(CallbackFailureWatch.selectorOf(hex"489f3c"), bytes4(0), "3 bytes cannot hold a selector");
        assertEq(CallbackFailureWatch.selectorOf(abi.encodePacked(PING)), PING, "exactly 4 bytes");
    }

    function test_argWord_reverts_on_short_payload() public {
        bytes memory p = abi.encodeWithSelector(PING, address(0xA11CE), uint256(5));
        assertEq(this.argWordOf(p, 0), uint256(uint160(address(0xA11CE))));
        assertEq(this.argWordOf(p, 1), 5);
        vm.expectRevert(bytes("CallbackFailureWatch: short payload"));
        this.argWordOf(p, 2); // word 2 is past the end: never read past the payload
        vm.expectRevert(bytes("CallbackFailureWatch: short payload"));
        this.argWordOf(hex"489f3c88ff", 0); // a selector and one stray byte
    }
}
