/*
 * surveillance.yar — 监控行为与外传通道的组合
 *
 * 屏幕/剪贴板/键盘 API 单独出现可能来自辅助工具或文档；与网络外传同时出现
 * 才是「收集并带走」的形态。文档里的命中会被上下文降权，但组合结构仍然保留。
 */
rule Screen_Capture_With_Upload
{
    meta:
        severity = "high"
        category = "surveillance"
        confidence = "high"
        sr = "SR-03"
        description = "截屏并外发"
        remediation = "移除截屏外发；确有需要时逐次征得用户同意并本地留存"
    strings:
        $screen1 = "screencapture"
        $screen2 = "CGWindowListCreateImage"
        $screen3 = "xwd -root"
        $screen4 = "GetDC("
        $sink1 = "curl "
        $sink2 = "wget "
        $sink3 = "requests.post"
        $sink4 = "fetch("
    condition:
        any of ($screen*) and any of ($sink*)
}

rule Clipboard_Exfiltration
{
    meta:
        severity = "high"
        category = "surveillance"
        confidence = "high"
        sr = "SR-03"
        description = "读取剪贴板并外发"
        remediation = "移除剪贴板外发；剪贴板内容不得离开本机"
    strings:
        $clip1 = "pbpaste"
        $clip2 = "Get-Clipboard"
        $clip3 = "xclip -o"
        $clip4 = "pyperclip.paste"
        $sink1 = "curl "
        $sink2 = "wget "
        $sink3 = "requests.post"
        $sink4 = "socket."
    condition:
        any of ($clip*) and any of ($sink*)
}

rule Keylogger_With_Sink
{
    meta:
        severity = "critical"
        category = "surveillance"
        confidence = "high"
        sr = "SR-03"
        description = "键盘钩子与落盘/外传同时出现"
        remediation = "移除键盘监听与输出通道"
    strings:
        $api1 = "SetWindowsHookEx"
        $api2 = "GetAsyncKeyState"
        $api3 = "CGEventTapCreate"
        $api4 = "pynput.keyboard"
        $sink1 = "open("
        $sink2 = "WriteFile"
        $sink3 = "requests.post"
        $sink4 = "socket."
    condition:
        any of ($api*) and any of ($sink*)
}

rule Webcam_Microphone_Capture
{
    meta:
        severity = "medium"
        category = "surveillance"
        confidence = "medium"
        sr = "SR-03"
        description = "麦克风/摄像头采集并落盘或外发"
        remediation = "移除静默采集；媒体采集必须由用户显式授权"
    strings:
        $capture1 = "AVCaptureDevice"
        $capture2 = "getUserMedia"
        $capture3 = "arecord"
        $capture4 = "ffmpeg"
        $device1 = "avfoundation"
        $device2 = "dshow"
        $device3 = "v4l2"
        $sink1 = "open("
        $sink2 = "requests.post"
        $sink3 = "socket."
    condition:
        any of ($capture*) and any of ($device*) and any of ($sink*)
}
