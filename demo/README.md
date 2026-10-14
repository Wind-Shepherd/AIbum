# 公开演示素材包

包含 24 张来自 Lorem Picsum 的样图，原作者与原图链接见 sources.json；文件夹、日期与故事仅用于演示，不代表真实旅行。

music/memory-chime.wav 为本项目生成的原创短音阶，用于播放器测试。样图仍遵循原始来源的许可，项目 MIT 许可证只授权原创代码和明确原创的素材。

在项目根目录执行：

```powershell
.\.venv\Scripts\python.exe scripts\demo_bundle.py import --output tmp\public-demo
```

账号 demo / DemoAlbum2026!，管理员 demo_admin / DemoAdmin2026!。目标目录若已有数据库会拒绝覆盖。模型分析结果在导入后重建。
