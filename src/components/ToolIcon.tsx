import { IconTerminal, IconFileEdit, IconGlobe, IconTool } from "./icons";

export function ToolIcon({ tool }: { tool: string }) {
  const t = tool.toLowerCase();
  if (/(shell|bash|terminal|exec|command)/.test(t)) return <IconTerminal size={13} />;
  if (/(file|edit|write|read|patch)/.test(t)) return <IconFileEdit size={13} />;
  if (/(web|search|fetch|globe)/.test(t)) return <IconGlobe size={13} />;
  return <IconTool size={13} />;
}
