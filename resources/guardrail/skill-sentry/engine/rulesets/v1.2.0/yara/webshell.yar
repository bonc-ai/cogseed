/*
 * webshell.yar — WebShell 形态签名
 *
 * 判据统一是「执行入口 + 请求可控输入」同时出现。单独一个 eval( 在正常代码里
 * 很常见，单独一个 $_POST 也很常见；两者共存才是 WebShell 的结构。
 */
rule PHP_WebShell_Eval_Request
{
    meta:
        severity = "critical"
        category = "command_exec"
        confidence = "high"
        sr = "SR-03"
        description = "PHP WebShell 形态：eval 直接执行请求参数"
        remediation = "移除请求参数到代码执行的路径；如为合法功能，改为白名单分派并沙箱隔离"
    strings:
        $eval = "eval(" nocase
        $post = "$_POST"
        $get = "$_GET"
        $request = "$_REQUEST"
        $input = "php://input"
    condition:
        $eval and any of ($post, $get, $request, $input)
}

rule PHP_WebShell_Assert_Request
{
    meta:
        severity = "critical"
        category = "command_exec"
        confidence = "high"
        sr = "SR-03"
        description = "PHP WebShell 形态：assert 执行请求参数"
        remediation = "移除 assert/请求参数的组合；assert 在现代 PHP 中不应承载用户输入"
    strings:
        $assert = "assert(" nocase
        $post = "$_POST"
        $get = "$_GET"
        $request = "$_REQUEST"
    condition:
        $assert and any of ($post, $get, $request)
}

rule PHP_Upload_Then_Execute
{
    meta:
        severity = "critical"
        category = "command_exec"
        confidence = "high"
        sr = "SR-03"
        description = "PHP 上传文件后直接执行（一句话木马的落地方式）"
        remediation = "上传目录不得可执行；校验扩展名与内容类型，并把文件移出 Web 根目录"
    strings:
        $upload = "move_uploaded_file" nocase
        $files = "$_FILES"
        $exec1 = "include"
        $exec2 = "require"
        $exec3 = "eval(" nocase
        $exec4 = "system(" nocase
    condition:
        $upload and $files and any of ($exec*)
}

rule JSP_WebShell_Runtime_Exec
{
    meta:
        severity = "critical"
        category = "command_exec"
        confidence = "high"
        sr = "SR-03"
        description = "JSP WebShell 形态：Runtime.exec 执行请求参数"
        remediation = "移除从请求参数到 Runtime.exec 的路径"
    strings:
        $exec = "Runtime.getRuntime().exec"
        $param1 = "request.getParameter"
        $param2 = "request.getHeader"
    condition:
        $exec and any of ($param*)
}

rule ASP_WebShell_Execute_Request
{
    meta:
        severity = "critical"
        category = "command_exec"
        confidence = "high"
        sr = "SR-03"
        description = "ASP WebShell 形态：Execute 执行请求参数"
        remediation = "移除 Execute/请求对象的组合"
    strings:
        $exec = "Execute(" nocase
        $request1 = "Request(" nocase
        $request2 = "Request.Form" nocase
        $request3 = "Request.QueryString" nocase
    condition:
        $exec and any of ($request*)
}

rule Python_Request_To_Shell
{
    meta:
        severity = "high"
        category = "command_exec"
        confidence = "high"
        sr = "SR-03"
        description = "Python：请求参数直接进入 shell 执行"
        remediation = "改为参数数组 + 白名单校验；不要拼接用户输入到命令行"
    strings:
        $sink1 = "os.system("
        $sink2 = "subprocess.run("
        $sink3 = "subprocess.Popen("
        $sink4 = "subprocess.call("
        $source1 = "request.args"
        $source2 = "request.form"
        $source3 = "request.get_json"
        $source4 = "BaseHTTPRequestHandler"
    condition:
        any of ($sink*) and any of ($source*)
}

rule Node_Request_To_Shell
{
    meta:
        severity = "high"
        category = "command_exec"
        confidence = "medium"
        sr = "SR-03"
        description = "Node.js：请求参数直接进入子进程执行"
        remediation = "改用 execFile/spawn 的参数数组形式，并对输入做白名单校验"
    strings:
        $module = "child_process"
        $sink1 = "exec("
        $sink2 = "execSync("
        $source1 = "req.query"
        $source2 = "req.body"
        $source3 = "req.params"
    condition:
        $module and any of ($sink*) and any of ($source*)
}
