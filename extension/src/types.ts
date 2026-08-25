export type ConnectionState = "unpaired" | "connecting" | "online" | "offline";
export type WaitState = "IDLE" | "ARMED" | "ARMED_OFFLINE" | "CODE_READY" | "EXPIRED";

export interface PanelPosition {
  x: number;
  y: number;
  collapsed: boolean;
}

export interface ExtensionConfig {
  phoneNumber: string;
  host: string;
  port: number;
  clientId: string;
  deviceId?: string;
  pairingKey?: string;
  allowedDomains: string[];
  excludedDomains: string[];
  soundEnabled: boolean;
  panelPosition?: PanelPosition;
}

export interface BridgeRuntimeState {
  connection: ConnectionState;
  notificationAccess?: boolean;
  waitState: WaitState;
  requestId?: string;
  armedTabId?: number;
  createdAt?: number;
  waitExpiresAt?: number;
  code?: string;
  candidates?: string[];
  codeExpiresAt?: number;
  messageId?: string;
  receivedAt?: number;
  sourceAppLabel?: string;
  confidence?: number;
  error?: string;
}

export interface PanelState extends Omit<BridgeRuntimeState, "armedTabId"> {
  maskedPhone: string;
}

export interface ArmPayload {
  requestId: string;
  createdAt: number;
  expiresAt: number;
  expectedDigits: number[];
  siteLabel: string;
}

export interface Envelope {
  v: 1;
  type: "ARM" | "OTP" | "ACK" | "PING" | "PONG" | "CANCEL" | "ERROR";
  deviceId: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  nonce: string;
  ciphertext: string;
}

export interface FocusTarget {
  tabId: number;
  frameId: number;
  documentId?: string;
  kind: "phone" | "otp" | "generic";
  url: string;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  phoneNumber: "",
  host: "",
  port: 0,
  clientId: "",
  allowedDomains: [],
  excludedDomains: [],
  soundEnabled: true,
  panelPosition: undefined
};

export const DEFAULT_RUNTIME_STATE: BridgeRuntimeState = {
  connection: "unpaired",
  waitState: "IDLE"
};
