export interface ServerMethods {
  getServerInfo(): { name: string }
}

export interface ClientMethods {
  getClientInfo(): { name: string; version: string }
}
