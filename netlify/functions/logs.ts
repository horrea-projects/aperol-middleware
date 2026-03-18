import type { Handler } from "@netlify/functions";
import { getLogEntries } from "../../src/utils/locks";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }
  const limit = Math.min(Number(event.queryStringParameters?.limit) || 100, 200);
  try {
    const entries = await getLogEntries(limit);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ logs: entries })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: String(err) })
    };
  }
};
