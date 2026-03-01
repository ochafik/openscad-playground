import React from "react";
import { Model } from "../state/model.ts";
import { McpAppClient } from "../state/mcp-app.ts";

export const FSContext = React.createContext<FS | undefined>(undefined);

export const ModelContext = React.createContext<Model | null>(null);

export const McpContext = React.createContext<McpAppClient | null>(null);

