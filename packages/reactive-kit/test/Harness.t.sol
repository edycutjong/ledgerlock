// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "reactive-lib-omni/base/AbstractReactive.sol";
import {AbstractCallback} from "reactive-lib-omni/base/AbstractCallback.sol";
import {AbstractPayer} from "reactive-lib-omni/base/AbstractPayer.sol";
import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";
import {IPayable} from "reactive-lib-omni/interfaces/IPayable.sol";
import {ReactiveConstants} from "reactive-test-lib/constants/ReactiveConstants.sol";
import {CallbackResult} from "reactive-test-lib/interfaces/IReactiveInterfaces.sol";
import {OmniReactiveTest} from "../src/test/OmniReactiveTest.sol";
import {OmniSystemMock} from "../src/test/OmniSystemMock.sol";
import {CronTopics} from "../src/CronTopics.sol";

contract MiniToken {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfer(address to, uint256 v) external returns (bool) {
        emit Transfer(msg.sender, to, v);
        return true;
    }
}

/// Destination with BOTH guards, emitting Ack(seq) so the RC can close the loop.
contract EchoDest is AbstractCallback {
    uint256 public lastSeq;
    address public lastRvm;

    event Ack(uint256 indexed seq);

    constructor(address proxy_, address rc_) AbstractCallback(IPayable(payable(proxy_)), rc_) {}

    function sync(address rvm, uint256 seq) external onlyServiceProvider onlyCallbackSender(rvm) {
        lastSeq = seq;
        lastRvm = rvm;
        emit Ack(seq);
    }
}

contract EchoReactive is AbstractReactive {
    uint256 internal constant TRANSFER = uint256(keccak256("Transfer(address,address,uint256)"));
    uint256 internal constant ACK = uint256(keccak256("Ack(uint256)"));
    uint256 public immutable originChain;
    uint256 public immutable destChain;
    address public token;
    address public dest;
    uint256 public seq;
    uint256 public cronTicks;
    mapping(uint256 => bool) public acked;

    constructor(uint256 originChain_, uint256 destChain_) {
        originChain = originChain_;
        destChain = destChain_;
    }

    function wire(address token_, address owner_, address dest_, bool anyChain) external {
        token = token_;
        dest = dest_;
        SYSTEM.subscribe(anyChain ? 0 : originChain, token_, TRANSFER, uint256(uint160(owner_)), REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(destChain, dest_, ACK, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function unwireToken(address owner_) external {
        SYSTEM.unsubscribe(originChain, token, TRANSFER, uint256(uint160(owner_)), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function cronOn() external {
        SYSTEM.subscribe(block.chainid, CronTopics.LEGACY_SYSTEM_ADDR, CronTopics.CRON10, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function react(LogRecord calldata log_) external onlySystem {
        if (CronTopics.isCron(log_.contractAddress, log_.topic0)) {
            cronTicks++;
        } else if (log_.topic0 == ACK && log_.contractAddress == dest) {
            acked[log_.topic1] = true;
        } else if (log_.topic0 == TRANSFER) {
            SYSTEM.requestCallbackV_1_0(
                ISystemContract.CallbackConfiguration_V_1_0(
                    destChain, dest, 1_000_000, abi.encodeWithSignature("sync(address,uint256)", address(0), ++seq)
                )
            );
        }
    }
}

contract HarnessTest is OmniReactiveTest {
    uint256 constant ORIGIN = 84532;
    uint256 constant DEST = 8453;
    address owner = makeAddr("owner");
    MiniToken token;
    EchoReactive rc;
    EchoDest dest;

    function setUp() public override {
        super.setUp();
        token = new MiniToken();
        rc = new EchoReactive(ORIGIN, DEST);
        dest = new EchoDest(address(proxy), address(rc));
        onChain(address(token), ORIGIN);
        onChain(address(dest), DEST);
    }

    function test_transfer_callback_ack_loop() public {
        rc.wire(address(token), owner, address(dest), false);
        CallbackResult[] memory r = cycle(owner, address(token), abi.encodeCall(MiniToken.transfer, (address(1), 5)));
        assertCallbacks(r, 1);
        assertAllSucceeded(r);
        assertEq(dest.lastSeq(), 1);
        assertEq(dest.lastRvm(), address(rc), "injected identity = requesting RC (as measured on Lasna)");
        assertTrue(rc.acked(1), "Ack fed back to the RC");
    }

    function test_injected_deployer_identity_is_rejected() public {
        rc.wire(address(token), owner, address(dest), false);
        injectRequester = false; // reactive-test-lib's documented behaviour (deployer injected)
        CallbackResult[] memory r = step(owner, address(token), abi.encodeCall(MiniToken.transfer, (address(1), 5)));
        assertCallbacks(r, 1);
        assertFalse(r[0].success);
        assertEq(bytes4(r[0].returnData), AbstractCallback.CallbackNotAuthorized.selector);
    }

    function test_direct_call_rejected_by_service_provider_guard() public {
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        dest.sync(address(rc), 7);
    }

    function test_non_owner_transfer_not_delivered() public {
        rc.wire(address(token), owner, address(dest), false);
        CallbackResult[] memory r = step(makeAddr("other"), address(token), abi.encodeCall(MiniToken.transfer, (address(1), 5)));
        assertCallbacks(r, 0);
    }

    function test_wrong_chain_not_delivered_unless_wildcard() public {
        onChain(address(token), 1301);
        rc.wire(address(token), owner, address(dest), false);
        assertCallbacks(step(owner, address(token), abi.encodeCall(MiniToken.transfer, (address(1), 1))), 0);
        rc.wire(address(token), owner, address(dest), true); // chain 0 = any chain
        assertCallbacks(step(owner, address(token), abi.encodeCall(MiniToken.transfer, (address(1), 1))), 1);
    }

    function test_unsubscribe_stops_delivery() public {
        rc.wire(address(token), owner, address(dest), false);
        assertEq(sys.activeSubscriptions(address(rc)), 2);
        rc.unwireToken(owner);
        assertEq(sys.activeSubscriptions(address(rc)), 1);
        assertCallbacks(step(owner, address(token), abi.encodeCall(MiniToken.transfer, (address(1), 1))), 0);
    }

    function test_cron_real_topic_reaches_react() public {
        rc.cronOn();
        cron(CronTopics.CRON10);
        cron(CronTopics.CRON100); // not subscribed
        assertEq(rc.cronTicks(), 1);
    }

    function test_testlib_cron_topics_are_placeholders() public pure {
        // Documented DX finding: reactive-test-lib's CRON constants do not match the network's topics.
        assertTrue(ReactiveConstants.CRON_TOPIC_10 != CronTopics.CRON10);
        assertTrue(ReactiveConstants.CRON_TOPIC_100 != CronTopics.CRON100);
        assertTrue(address(ReactiveConstants.SERVICE_ADDR) == CronTopics.LEGACY_SYSTEM_ADDR);
    }

    function test_react_only_from_system() public {
        EchoReactive.LogRecord memory l;
        vm.expectPartialRevert(AbstractPayer.NotAuthorized.selector);
        rc.react(l);
    }

    function test_subscribe_needs_a_specific_criterion() public {
        vm.expectRevert(OmniSystemMock.NoSpecificCriterion.selector);
        sys.subscribe(0, address(0), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }
}
