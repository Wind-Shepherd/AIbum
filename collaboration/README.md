# 本地测试账号协作素材

按用户要求保留 test 账号的照片、文件分布、音乐、故事、标签和收藏。local-account/ 是可随仓库交付的素材快照；不含真实数据库、密码摘要、登录会话、恢复码或 API 密钥，也不修改原库。

本次快照：101 张照片、5 个文件夹、1 首音乐。

```powershell
.\.venv\Scripts\python.exe scripts\demo_bundle.py import --bundle collaboration\local-account --output tmp\collaborator-data --use-test-account
```

在新库生成普通账号 test / 123456789，管理员 demo_admin / DemoAdmin2026!。管理员是重新创建的演示身份，不是原库管理员凭据。这些口令仅供隔离开发环境。完整启动方法见根目录 README。

照片与音乐作为用户指定的协作素材保留，不因代码 MIT 许可证自动获得相同许可。本轮没有发布到远程仓库。
