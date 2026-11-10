export interface HostRecord {
  id: string;
  label: string;
  /** Resolved host address, or a manually entered hostname / IP. */
  host: string;
  /** Original OpenSSH Host alias. Kept for ProxyCommand, keepalive and other options. */
  sshAlias?: string;
  port?: number;
  user?: string;
  /** Path to a private key. The key itself is never copied or logged. */
  identityFile?: string;
  identityAgent?: string;
  useAgent?: boolean;
  useSshConfig?: boolean;
  configFile?: string;
  hostKeyAlias?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  token: string;
  connectionId: string;
  hostLabel: string;
  remoteRoot: string;
  remoteHome: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface RecentWorkspace {
  connectionId: string;
  hostLabel: string;
  remoteRoot: string;
  openedAt: string;
}

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'closed' | 'failed';

export interface ConnectionStatus {
  id: string;
  label: string;
  state: ConnectionState;
  hostName: string;
  port: number;
  user: string;
  connectedAt?: string;
  lastError?: string;
  reconnectCount: number;
  trustedFingerprint?: string;
}
