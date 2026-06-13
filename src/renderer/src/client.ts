import { client } from '../../api/server/generated/client.gen'
import { SERVER_ORIGIN } from '../../api/server/config'

/**
 * Points the generated API client at the local Fastify server. Generic across
 * roles — any renderer that talks to the server calls this once at startup.
 */
export function configureApiClient(): void {
  client.setConfig({ baseUrl: SERVER_ORIGIN })
}
