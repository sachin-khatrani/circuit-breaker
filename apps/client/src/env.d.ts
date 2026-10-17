interface ImportMetaEnv {
  /**
   * The game server's origin, set only when this client is built for another origin than the
   * server's (see docs/08-ranking.md §9). Unset: the page's own origin, as in production.
   */
  readonly VITE_SERVER_URL?: string;
}
