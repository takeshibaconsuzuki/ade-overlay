export interface HttpClient {
  fetch(url: string, options?: RequestInit): Promise<Response>
}

export class FetchHttpClient implements HttpClient {
  fetch(url: string, options?: RequestInit): Promise<Response> {
    return fetch(url, options)
  }
}
