// tools/cancel-appointment.js — cancel_appointment Tool
import { cancelAppointment } from "../lib/scheduler-client.js";

export const cancelAppointmentTool = {
  name: "cancel_appointment",
  description: "取消已有预约。要求至少提前 1 小时取消，否则需要人工审批。",
  parameters: {
    type: "object",
    properties: {
      appointment_id: { type: "integer", description: "预约 ID" },
      reason: { type: "string", description: "取消原因" },
    },
    required: ["appointment_id"],
  },
  execute: async (_toolCallId, params) => {
    const res = await cancelAppointment(params.appointment_id, params.reason || "");
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  },
};
