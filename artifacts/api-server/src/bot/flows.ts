import type { FormStep } from "./session.js";

/**
 * Flow definition.
 *
 * `acl` is the action key (see `permissions.ts ACTION_PERMISSIONS`) that
 * `submitForm` re-checks when the user confirms. Defends against
 * stale-session privilege escalation: router gates the flow's *entry*
 * callback, but `FORM:SELECT` confirm path bypasses router-level ACL.
 *
 * **Required by R1 (架构宪法)**: every flow MUST declare `acl` explicitly,
 * even ALL_USERS flows — they declare their canonical action key (e.g.
 * `TASK:NEW`, which is mapped to `ALL_USERS` in `ACTION_PERMISSIONS`).
 * No implicit ALL_USERS — boot-time invariant `assertFlowAclExists` rejects
 * any flow without `acl`. This eliminates the white-list drift risk.
 */
export type FlowDef = {
  title: string;
  acl: string;
  steps: FormStep[];
};

export const FLOWS: Record<string, FlowDef> = {
  "TASK:NEW": {
    title: "创建任务",
    acl: "TASK:NEW", // ALL_USERS via ACTION_PERMISSIONS — declared explicitly per R1.
    steps: [
      { key: "title", type: "text", prompt: "📝 请输入任务标题：", required: true, max_length: 120 },
      { key: "description", type: "text", prompt: "📄 请输入任务描述（可选，发送 /skip 跳过）：", required: false, max_length: 2000 },
      { key: "project_id", type: "select", prompt: "📁 请选择归属项目：", required: true, options: [
        { text: "（不归属）", value: "NONE" },
      ]},
      { key: "assignee_id", type: "select", prompt: "👤 请选择负责人：", required: true, options: [
        { text: "（暂不指派）", value: "NONE" },
      ]},
      { key: "priority", type: "select", prompt: "🎯 请选择优先级：", required: true, options: [
        { text: "🔥 高", value: "HIGH" },
        { text: "⚡ 中", value: "MEDIUM" },
        { text: "🌿 低", value: "LOW" },
      ]},
      { key: "due_date", type: "date_quick", prompt: "📅 请选择截止日期：", required: true, options: [
        { text: "📌 今天", value: "TODAY" },
        { text: "📍 明天", value: "TOMORROW" },
        { text: "📅 本周末", value: "THIS_WEEKEND" },
        { text: "🗓 7天后", value: "7DAYS" },
      ]},
      { key: "confirm", type: "confirm", prompt: "✅ 确认创建任务？", required: true, options: [
        { text: "✅ 确认发布", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "PROJ:NEW": {
    title: "新建项目",
    acl: "PROJ:NEW",
    steps: [
      { key: "name", type: "text", prompt: "📁 请输入项目名称：", required: true, max_length: 100 },
      { key: "description", type: "text", prompt: "📄 请输入项目描述（可选，发送 /skip 跳过）：", required: false, max_length: 2000 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认创建项目？", required: true, options: [
        { text: "✅ 确认创建", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "REQ:NEW": {
    title: "发布需求",
    acl: "REQ:NEW", // ALL_USERS — explicit per R1.
    steps: [
      { key: "title", type: "text", prompt: "📝 请输入需求标题：", required: true, max_length: 120 },
      { key: "background", type: "text", prompt: "📋 请输入需求背景/说明：", required: true, max_length: 2000 },
      { key: "acceptance", type: "text", prompt: "✅ 请输入验收标准：", required: true, max_length: 2000 },
      { key: "project_id", type: "select", prompt: "📁 请选择归属项目：", required: true, options: [
        { text: "（不归属）", value: "NONE" },
      ]},
      { key: "priority", type: "select", prompt: "🎯 请选择优先级：", required: true, options: [
        { text: "🔥 高", value: "HIGH" },
        { text: "⚡ 中", value: "MEDIUM" },
        { text: "🌿 低", value: "LOW" },
      ]},
      { key: "confirm", type: "confirm", prompt: "✅ 确认提交需求？", required: true, options: [
        { text: "✅ 确认提交", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "REQ:APP": {
    title: "批准需求",
    acl: "REQ:APP",
    steps: [
      { key: "review_note", type: "text", prompt: "📝 请输入审核意见（可选，发送 /skip 跳过）：", required: false, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认批准立项？", required: true, options: [
        { text: "👍 确认批准", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "REQ:REJ": {
    title: "驳回需求",
    acl: "REQ:REJ",
    steps: [
      { key: "review_note", type: "text", prompt: "📝 请输入驳回理由（必填）：", required: true, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "❌ 确认驳回该需求？", required: true, options: [
        { text: "❌ 确认驳回", value: true },
        { text: "🔙 取消", value: false },
      ]},
    ],
  },
  "DOC:ADD": {
    title: "上传文档",
    acl: "DOC:ADD", // ALL_USERS — explicit per R1.
    steps: [
      { key: "doc_title", type: "text", prompt: "📝 请输入文档标题：", required: true, max_length: 150 },
      { key: "category", type: "select", prompt: "📂 请选择文档分类：", required: true, options: [
        { text: "📌 制度流程", value: "POLICY" },
        { text: "📁 项目资料", value: "PROJECT" },
        { text: "📝 会议纪要", value: "MINUTES" },
        { text: "📚 知识沉淀", value: "KNOWLEDGE" },
        { text: "💰 财务凭证", value: "FINANCE" },
        { text: "📎 其他", value: "OTHER" },
      ]},
      { key: "project_id", type: "select", prompt: "📁 请选择关联项目：", required: true, options: [
        { text: "（不关联）", value: "NONE" },
      ]},
      { key: "url", type: "text", prompt: "🔗 请输入文档链接或内容描述：", required: true, max_length: 1000 },
      { key: "tags", type: "text", prompt: "🏷 请输入标签（逗号分隔，可选，发送 /skip 跳过）：", required: false, max_length: 200 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认归档该文档？", required: true, options: [
        { text: "✅ 确认归档", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "DOC:EDITTAGS": {
    title: "编辑标签",
    acl: "DOC:EDITTAGS",
    steps: [
      { key: "tags", type: "text", prompt: "🏷 请输入新的标签（逗号分隔，发送 /skip 清空标签）：", required: false, max_length: 200 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认更新标签？", required: true, options: [
        { text: "✅ 确认更新", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "DOC:PURGE": {
    title: "彻底删除文档",
    acl: "DOC:PURGE",
    steps: [
      { key: "confirm", type: "confirm", prompt: "☠️ <b>确认彻底删除该文档？</b>\n\n该操作不可撤销，且不进入回收站。如只想隐藏文档，请使用归档；如希望可恢复，请使用删除（移入回收站）。", required: true, options: [
        { text: "☠️ 确认彻底删除", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "FIN:REIMB": {
    title: "报销申请",
    acl: "FIN:REIMB", // ALL_USERS — explicit per R1.
    steps: [
      { key: "amount", type: "number", prompt: "💰 请输入报销金额：", required: true, min: 0.01 },
      { key: "currency", type: "select", prompt: "💱 请选择币种：", required: true, options: [
        { text: "CNY ¥", value: "CNY" },
        { text: "USD $", value: "USD" },
        { text: "USDT ₮", value: "USDT" },
      ]},
      { key: "project_id", type: "select", prompt: "📁 请选择关联项目：", required: true, options: [
        { text: "（不关联）", value: "NONE" },
      ]},
      { key: "purpose", type: "text", prompt: "📋 请输入用途说明：", required: true, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认提交报销申请？", required: true, options: [
        { text: "✅ 提交审核", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "FIN:IN": {
    title: "录入收入",
    acl: "FIN:IN",
    steps: [
      { key: "amount", type: "number", prompt: "💰 请输入收入金额：", required: true, min: 0.01 },
      { key: "currency", type: "select", prompt: "💱 请选择币种：", required: true, options: [
        { text: "CNY ¥", value: "CNY" },
        { text: "USD $", value: "USD" },
        { text: "USDT ₮", value: "USDT" },
      ]},
      { key: "project_id", type: "select", prompt: "📁 请选择关联项目：", required: true, options: [
        { text: "（不关联）", value: "NONE" },
      ]},
      { key: "purpose", type: "text", prompt: "📋 请输入收入来源/说明：", required: true, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认录入收入？", required: true, options: [
        { text: "✅ 确认录入", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "FIN:OUT": {
    title: "录入支出",
    acl: "FIN:OUT",
    steps: [
      { key: "amount", type: "number", prompt: "💰 请输入支出金额：", required: true, min: 0.01 },
      { key: "currency", type: "select", prompt: "💱 请选择币种：", required: true, options: [
        { text: "CNY ¥", value: "CNY" },
        { text: "USD $", value: "USD" },
        { text: "USDT ₮", value: "USDT" },
      ]},
      { key: "project_id", type: "select", prompt: "📁 请选择关联项目：", required: true, options: [
        { text: "（不关联）", value: "NONE" },
      ]},
      { key: "purpose", type: "text", prompt: "📋 请输入支出用途：", required: true, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认录入支出？", required: true, options: [
        { text: "✅ 确认录入", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "FIN:PASS": {
    title: "审核通过",
    acl: "FIN:PASS",
    steps: [
      { key: "review_note", type: "text", prompt: "📝 请输入审核意见（可选，发送 /skip 跳过）：", required: false, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认审核通过？", required: true, options: [
        { text: "✅ 确认通过", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "FIN:FAIL": {
    title: "驳回审核",
    acl: "FIN:FAIL",
    steps: [
      { key: "review_note", type: "text", prompt: "📝 请输入驳回理由（必填）：", required: true, max_length: 500 },
      { key: "confirm", type: "confirm", prompt: "❌ 确认驳回？", required: true, options: [
        { text: "❌ 确认驳回", value: true },
        { text: "🔙 取消", value: false },
      ]},
    ],
  },
  "PROJ:NEWMILE": {
    title: "新建里程碑",
    acl: "PROJ:NEWMILE",
    steps: [
      { key: "title", type: "text", prompt: "🎯 请输入里程碑名称：", required: true, max_length: 120 },
      { key: "due_date", type: "date_quick", prompt: "📅 请选择里程碑截止日期：", required: true, options: [
        { text: "📍 7天后", value: "7DAYS" },
        { text: "🗓 本周末", value: "THIS_WEEKEND" },
        { text: "📅 本周", value: "THIS_WEEK" },
        { text: "📆 本月底", value: "THIS_MONTH" },
      ]},
      { key: "confirm", type: "confirm", prompt: "✅ 确认创建里程碑？", required: true, options: [
        { text: "✅ 确认创建", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "GROUP:SETDEFCH": {
    title: "设置默认报告频道",
    acl: "GROUPS:SETDEFCH",
    steps: [
      { key: "channel_id", type: "text", prompt: "📊 请输入<b>默认报告频道</b>的 chat_id（如 <code>-1001234567890</code>）：\n\n💡 在目标频道里发送 /chatid 可获取。", required: true, max_length: 32 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认绑定？", required: true, options: [
        { text: "✅ 确认", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "GROUP:SETFINCH": {
    title: "设置财务频道",
    acl: "GROUPS:SETFINCH",
    steps: [
      { key: "channel_id", type: "text", prompt: "💰 请输入<b>财务频道</b>的 chat_id（如 <code>-1001234567890</code>）：\n\n💡 在目标频道里发送 /chatid 可获取。\n⚠️ 财务事件只播到此频道，不会降级。", required: true, max_length: 32 },
      { key: "confirm", type: "confirm", prompt: "✅ 确认绑定？", required: true, options: [
        { text: "✅ 确认", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
  "PROJ:RISK": {
    title: "风险/阻塞登记",
    acl: "PROJ:RISK", // ALL_USERS — explicit per R1.
    steps: [
      { key: "title", type: "text", prompt: "⚠️ 请描述风险/阻塞问题：", required: true, max_length: 200 },
      { key: "description", type: "text", prompt: "📄 请输入详细说明（可选，发送 /skip 跳过）：", required: false, max_length: 1000 },
      { key: "severity", type: "select", prompt: "🚨 请选择严重程度：", required: true, options: [
        { text: "🔴 高", value: "HIGH" },
        { text: "🟡 中", value: "MEDIUM" },
        { text: "🟢 低", value: "LOW" },
      ]},
      { key: "confirm", type: "confirm", prompt: "✅ 确认登记该风险？", required: true, options: [
        { text: "✅ 确认登记", value: true },
        { text: "❌ 取消", value: false },
      ]},
    ],
  },
};

export function resolveDueDate(value: string): Date {
  const now = new Date();
  if (value === "TODAY") return now;
  if (value === "TOMORROW") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (value === "THIS_WEEKEND") {
    const d = new Date(now);
    const day = d.getDay();
    const daysToSat = (6 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + daysToSat);
    return d;
  }
  if (value === "7DAYS") {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    return d;
  }
  if (value === "THIS_WEEK") {
    const d = new Date(now);
    const daysToSun = (7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysToSun);
    return d;
  }
  if (value === "THIS_MONTH") {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }
  return now;
}
