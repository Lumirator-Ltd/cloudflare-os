type Env = {
  VERSION: string;
};

export default {
  fetch(_request, env): Response {
    return Response.json({ version: env.VERSION });
  },
} satisfies ExportedHandler<Env>;
