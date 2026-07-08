import { createAuthDb, type AuthDb } from "../db/auth";
import { getKernel } from "../actions/runtime";
import { DashboardAuth } from "./session";

let authDb: AuthDb | null = null;
let dashboardAuth: DashboardAuth | null = null;

function getAuthDb(): AuthDb {
  if (authDb === null) {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString === "") {
      throw new Error("DATABASE_URL is not configured");
    }
    authDb = createAuthDb(connectionString);
  }
  return authDb;
}

export function getDashboardAuth(): DashboardAuth {
  if (dashboardAuth === null) {
    dashboardAuth = new DashboardAuth(getAuthDb(), getKernel);
  }
  return dashboardAuth;
}
