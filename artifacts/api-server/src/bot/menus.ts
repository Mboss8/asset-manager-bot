import type { Context } from "telegraf";
import { editOrSend, buildKeyboard } from "./helpers.js";
import type { Role } from "./permissions.js";
import { canAccess, canExecuteAction } from "./permissions.js";

interface MenuButton {
  text: string;
  callback_data: string;
  visible_roles: string;
}

function actionKeyForCallback(callbackData: string): string {
  const parts = callbackData.split(":");
  if (parts[0] === "M") return `M:${parts[1]}`;
  return `${parts[0]}:${parts[1]}`;
}

const ALL_MENUS: Record<string, { title: string; description: string; buttons: MenuButton[]; footer: { text: string; callback_data: string }[] }> = {
  "M:HOME": {
    title: "📌 内部协作控制台",
    description: "让任务有闭环，让项目有节奏，让资金有轨迹。",
    buttons: [
      { text: "📁 项目管理", callback_data: "M:PROJ", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "✅ 任务中心", callback_data: "M:TASK", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📌 需求池", callback_data: "M:REQ", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📚 文档沉淀", callback_data: "M:DOC", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "💰 资金动向", callback_data: "M:FIN", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📊 数据看板", callback_data: "M:BI", visible_roles: "ALL_USERS" },
      { text: "👥 成员/权限", callback_data: "M:MEM", visible_roles: "ADMIN_ONLY" },
      { text: "⚙️ 系统设置", callback_data: "M:SET", visible_roles: "ADMIN_ONLY" },
    ],
    footer: [{ text: "🔍 搜索", callback_data: "M:SEARCH" }],
  },
  "M:PROJ": {
    title: "📁 项目管理",
    description: "以里程碑驱动进度，以指标锁定交付。",
    buttons: [
      { text: "➕ 新建项目", callback_data: "PROJ:NEW", visible_roles: "PM_OR_ADMIN" },
      { text: "📋 项目列表", callback_data: "PROJ:LIST", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "🎯 里程碑管理", callback_data: "PROJ:MILE", visible_roles: "PM_OR_ADMIN" },
      { text: "⚠️ 风险/阻塞登记", callback_data: "PROJ:RISK", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📌 项目周报生成", callback_data: "PROJ:REPORT", visible_roles: "PM_OR_ADMIN" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:TASK": {
    title: "✅ 任务中心",
    description: "把讨论变成行动，把行动变成结果。",
    buttons: [
      { text: "➕ 新建任务", callback_data: "TASK:NEW", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "👤 我的任务", callback_data: "TASK:MY", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📌 今日待办", callback_data: "TASK:TODAY", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "⏳ 即将到期", callback_data: "TASK:DUESOON", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "🚨 超期任务", callback_data: "TASK:OVERDUE", visible_roles: "PM_OR_ADMIN" },
      { text: "📂 已归档任务", callback_data: "TASK:ARCH", visible_roles: "PM_OR_ADMIN" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:REQ": {
    title: "📌 需求池",
    description: "需求必须有编号、有结论、有归宿。",
    buttons: [
      { text: "➕ 发布需求", callback_data: "REQ:NEW", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📥 待评审需求", callback_data: "REQ:PENDING", visible_roles: "PM_OR_ADMIN" },
      { text: "🚀 已立项需求", callback_data: "REQ:APPROVED", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "❌ 已驳回需求", callback_data: "REQ:REJECTED", visible_roles: "PM_OR_ADMIN" },
      { text: "🧾 需求统计", callback_data: "REQ:STATS", visible_roles: "PM_OR_ADMIN" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:DOC": {
    title: "📚 文档沉淀",
    description: "把经验固化为资产，把知识沉淀为壁垒。",
    buttons: [
      { text: "➕ 上传文档", callback_data: "DOC:ADD", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📋 全部文档", callback_data: "DOC:LIST:ALL:0", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📌 置顶文档", callback_data: "DOC:LIST:PINNED:0", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "👤 我上传的", callback_data: "DOC:LIST:MINE:0", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📂 分类目录", callback_data: "DOC:CATE", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📁 按项目浏览", callback_data: "DOC:LINKPROJ:0", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "📝 会议纪要", callback_data: "DOC:MINUTES", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "🔍 搜索文档", callback_data: "DOC:SEARCH", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "🗄 已归档", callback_data: "DOC:LIST:ARCH:0", visible_roles: "PM_OR_ADMIN" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:FIN": {
    title: "💰 资金动向",
    description: "每一笔钱都要可追溯，每一次支出都要可审计。",
    buttons: [
      { text: "➕ 录入收入", callback_data: "FIN:IN", visible_roles: "FINANCE_OR_ADMIN" },
      { text: "➖ 录入支出", callback_data: "FIN:OUT", visible_roles: "FINANCE_OR_ADMIN" },
      { text: "🧾 报销申请", callback_data: "FIN:REIMB", visible_roles: "MEMBER_OR_ABOVE" },
      { text: "⏳ 待审核", callback_data: "FIN:APPROVALS", visible_roles: "FINANCE_OR_ADMIN" },
      { text: "📊 月度报表", callback_data: "FIN:MONTHLY", visible_roles: "FINANCE_OR_ADMIN" },
      { text: "📂 按项目统计", callback_data: "FIN:BYPROJ", visible_roles: "FINANCE_OR_ADMIN" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:BI": {
    title: "📊 数据看板",
    description: "让团队的节奏可视化，让风险提前暴露。",
    buttons: [
      { text: "📌 今日概览", callback_data: "BI:DAILY", visible_roles: "ALL_USERS" },
      { text: "👤 我的看板", callback_data: "BI:MINE", visible_roles: "ALL_USERS" },
      { text: "📅 本周进度", callback_data: "BI:WEEKLY", visible_roles: "ALL_USERS" },
      { text: "📊 项目健康", callback_data: "BI:HEALTH", visible_roles: "PM_OR_ADMIN" },
      { text: "⚠️ 风险预警", callback_data: "BI:RISK", visible_roles: "PM_OR_ADMIN" },
      { text: "💰 月度资金流", callback_data: "BI:FIN", visible_roles: "FINANCE_OR_ADMIN" },
      { text: "🧾 自动生成周报", callback_data: "BI:REPORT", visible_roles: "PM_OR_ADMIN" },
      { text: "📢 推送看板", callback_data: "BI:PUSH", visible_roles: "ADMIN_ONLY" },
      { text: "📅 立即推送提醒", callback_data: "BI:DIGEST", visible_roles: "ADMIN_ONLY" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:MEM": {
    title: "👥 成员/权限",
    description: "用角色定义边界，用权限守住秩序。",
    buttons: [
      { text: "👤 成员列表", callback_data: "MEM:LIST:ALL:0", visible_roles: "ADMIN_ONLY" },
      { text: "🧩 角色分配", callback_data: "MEM:ROLE", visible_roles: "ADMIN_ONLY" },
      { text: "🛡 权限策略", callback_data: "MEM:POLICY", visible_roles: "ADMIN_ONLY" },
      { text: "📌 黑名单/白名单", callback_data: "MEM:ACL", visible_roles: "ADMIN_ONLY" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:SET": {
    title: "⚙️ 系统设置",
    description: "系统不是工具，是组织的规则引擎。",
    buttons: [
      { text: "⏰ 提醒策略", callback_data: "SET:REMIND", visible_roles: "ADMIN_ONLY" },
      { text: "🏷 标签体系", callback_data: "SET:TAGS", visible_roles: "ADMIN_ONLY" },
      { text: "📌 默认模板", callback_data: "SET:TEMPLATE", visible_roles: "ADMIN_ONLY" },
      { text: "🗃 数据导出", callback_data: "SET:EXPORT", visible_roles: "ADMIN_ONLY" },
      { text: "💾 自动备份", callback_data: "SET:BACKUP", visible_roles: "ADMIN_ONLY" },
      { text: "🧾 审计日志", callback_data: "SET:AUDIT", visible_roles: "ADMIN_ONLY" },
      { text: "📡 群组绑定", callback_data: "M:GROUPS", visible_roles: "ADMIN_ONLY" },
      { text: "🗑 回收站", callback_data: "M:TRASH", visible_roles: "ADMIN_ONLY" },
    ],
    footer: [{ text: "🔙 返回主页", callback_data: "M:HOME" }],
  },
  "M:GROUPS": {
    title: "📡 群组绑定",
    description: "广播路由中心。把群/频道纳入系统后，事件按项目绑定自动分流。",
    buttons: [
      { text: "📋 群组列表", callback_data: "GROUPS:LIST:0", visible_roles: "ADMIN_ONLY" },
      { text: "📁 项目绑定", callback_data: "GROUPS:PROJ:0", visible_roles: "ADMIN_ONLY" },
    ],
    footer: [
      { text: "🔙 返回系统设置", callback_data: "M:SET" },
      { text: "🏠 返回主页", callback_data: "M:HOME" },
    ],
  },
  "M:TRASH": {
    title: "🗑 回收站",
    description: "查看与恢复已软删的记录。彻底删除暂未开放。",
    buttons: [
      { text: "✅ 任务", callback_data: "TRASH:LIST:TASK:0", visible_roles: "ADMIN_ONLY" },
      { text: "📌 需求", callback_data: "TRASH:LIST:REQ:0", visible_roles: "ADMIN_ONLY" },
      { text: "💰 财务", callback_data: "TRASH:LIST:FIN:0", visible_roles: "ADMIN_ONLY" },
      { text: "📚 文档", callback_data: "TRASH:LIST:DOC:0", visible_roles: "ADMIN_ONLY" },
      { text: "📁 项目", callback_data: "TRASH:LIST:PROJ:0", visible_roles: "ADMIN_ONLY" },
    ],
    footer: [
      { text: "🔙 返回系统设置", callback_data: "M:SET" },
      { text: "🏠 返回主页", callback_data: "M:HOME" },
    ],
  },
};

export async function showMenu(ctx: Context, menuKey: string, role: Role): Promise<void> {
  const menu = ALL_MENUS[menuKey];
  if (!menu) {
    await ctx.reply("⚠️ 菜单不存在");
    return;
  }

  const visibleButtons = menu.buttons
    .filter((b) => canAccess(role, b.visible_roles))
    .map((b) => ({ text: b.text, callback_data: b.callback_data }));

  const visibleFooter = menu.footer.filter((b) =>
    canExecuteAction(role, actionKeyForCallback(b.callback_data)),
  );
  const keyboard = buildKeyboard(visibleButtons, 2, visibleFooter);
  const text = `<b>${menu.title}</b>\n<i>${menu.description}</i>`;
  await editOrSend(ctx, text, keyboard);
}
