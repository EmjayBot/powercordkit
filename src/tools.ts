// Tools-only site worker (community): serves prebuilt static labs from
// dist/tools (see `npm run build:tools`). No D1, no secrets, no API —
// Mail lives on powercordkit-community. Custom domain via routes below.
export default {
  async fetch(req: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    return env.ASSETS.fetch(req);
  },
};
