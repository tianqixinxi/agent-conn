/**
 * Public Claude Code harness entry point. `agent-comm` remains the composed CLI
 * distribution during 0.x, while integrations can depend on this narrow adapter.
 */
export {
  type ChannelBridge,
  type ChannelBridgeOptions,
  type ChannelNotification,
  createChannelBridge,
  DEFAULT_CHANNEL_RELAY_URL,
  type RunChannelOptions,
  runChannel,
} from 'agent-comm/channel'
