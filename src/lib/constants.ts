export enum ContainerStatus {
  Created = 1,
  Ready = 2,
  PendingStop = 3,
  Stopped = 4,
  Unknown = 5
}

export enum ContainerStatusReport {
  ContainerInstalled = 'ContainerInstalled',
  RequestDrained = 'RequestDrained',
  ContainerDisconnected = 'ContainerDisconnected'
}

export const kDefaultRequestId = 'unknown';
