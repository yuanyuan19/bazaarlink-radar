# Security Policy

## Supported versions

当前默认只支持最新的默认分支版本。请在报告中注明 commit、版本号和运行环境。

## Reporting a vulnerability

请通过 GitHub 私下联系仓库维护者，或使用 GitHub 的 Security Advisories 提交报告。不要在公开 Issue、Pull Request 或聊天记录中披露尚未修复的漏洞。

报告应包含：

- 影响范围和复现步骤
- 受影响的文件、接口或配置
- 潜在影响
- 可行的修复建议（如有）

请先移除 API Key、Cookie、访问令牌、真实端点凭据和其他个人数据。维护者确认后会尽快回复并协调修复与披露时间。

## Secret handling

不要把密钥写入源码、Issue、日志、SQLite 数据库或提交记录。若密钥意外暴露，应立即撤销并重新生成，而不是只删除文件。
