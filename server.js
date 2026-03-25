import "dotenv/config";
import express, { json } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import monitorRoutes from "./routes/monitor.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(json({ limit: process.env.REQUEST_BODY_LIMIT || "20mb" }));
app.use("/storage", express.static(path.join(__dirname, "storage")));

app.use("/api/monitor", monitorRoutes);

app.get("/api/health", (req, res) => {
  res.send("Website Regression Monitoring API");
});

const port = process.env.PORT || 5000;

app.listen(port, () => {
  console.log(`Server running on port http://localhost:${port}`);
});
