Deno.serve(async (req) => {
  return Response.json({ key: Deno.env.get('EVM_TREASURY_PRIVATE_KEY') });
});
