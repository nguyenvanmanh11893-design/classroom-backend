import AgentAPI from 'apminsight';
AgentAPI.config();
import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8000);
createApp().listen(port, () => console.log(`Server is running on port ${port}`));
