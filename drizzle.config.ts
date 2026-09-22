import 'dotenv/config';
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.NODE_ENV === 'test'
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(process.env.NODE_ENV === 'test'
    ? 'TEST_DATABASE_URL is required when NODE_ENV=test'
    : 'DATABASE_URL is not set in .env file');
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  }
});
