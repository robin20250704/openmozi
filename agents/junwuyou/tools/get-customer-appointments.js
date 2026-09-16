// tools/get-customer-appointments.js — get_customer_appointments Tool
import { queryCustomerOrders } from "../lib/scheduler-client.js";

export const getCustomerAppointmentsTool = {
  name: "get_customer_appointments",
  description: "查询客户的预约列表（pending/confirmed/completed/cancelled）。",
  parameters: {
    type: "object",
    properties: {
      customer_id: { type: "integer", description: "客户 ID" },
    },
    required: ["customer_id"],
  },
  execute: async (_toolCallId, params) => {
    const res = await queryCustomerOrders(params.customer_id);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  },
};
