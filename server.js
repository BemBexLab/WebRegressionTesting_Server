import "dotenv/config";
import express, { json } from "express";
import cors from "cors";

import monitorRoutes from "./routes/monitor.js";

const app = express();
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ||
  "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.options(/.*/, cors());
app.use(json({ limit: process.env.REQUEST_BODY_LIMIT || "20mb" }));

app.use("/api/monitor", monitorRoutes);

app.get("/api/health", (req, res) => {
  res.send("Website Regression Monitoring API");
});

const port = process.env.PORT || 5000;

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running on port http://localhost:${port}`);
  });
}

export default app;
