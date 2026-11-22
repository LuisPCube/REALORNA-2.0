import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/orders/$orderId")({ server: { handlers: {
  GET: async ({ request, params }) => {
    const { api, json, ApiError } = await import("@/realorna/backend/http");
    return api(async () => {
      const { requireAccount } = await import("@/realorna/backend/accounts");
      const { getOrder, publicOrder } = await import("@/realorna/backend/orders");
      const user = await requireAccount(request);
      const order = await getOrder(params.orderId, user.id);
      if (!order) throw new ApiError("not_found", 404);
      return json(publicOrder(order));
    });
  },
  POST: () => Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET" } }),
} } });
