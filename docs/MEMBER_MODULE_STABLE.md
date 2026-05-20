# 成员模块稳定规则

## Callback 标准

- 成员菜单：M:MEM
- 成员列表：MEM:LIST:ALL:0
- 成员详情：MEM:USER:<userId>
- 设置角色：MEM:SETROLE:<userId>:<ROLE>
- 加入黑名单：MEM:BLACKLIST:<userId>
- 解除黑名单：MEM:UNBLACKLIST:<userId>
- 搜索成员：MEM:SEARCH
- 权限矩阵：MEM:POLICY
- 黑白名单面板：MEM:ACL

## 兼容旧 callback

- MEM:SET_ROLE:<userId>:<ROLE> -> MEM:SETROLE
- MEM:BLACK:<userId> -> MEM:BLACKLIST
- MEM:WHITE:<userId> -> MEM:UNBLACKLIST

## 原则

具体路由永远放在 MEM 兜底前面。
未知 MEM 按钮只提示按钮版本过旧，不再自动跳回成员菜单，避免“循环错觉”。
