const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
  VerticalAlign, LevelFormat, TableOfContents, PageBreak, PageNumber,
  Footer,
} = require("docx");

const TB = { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" };
const CELL = { top: TB, bottom: TB, left: TB, right: TB };
const HEAD_FILL = "1F3864";
const ALT_FILL = "F2F5FA";

function h(text, level) { return new Paragraph({ heading: level, children: [new TextRun(text)] }); }
function p(text) {
  return new Paragraph({ spacing: { after: 120, line: 300 },
    children: Array.isArray(text) ? text : [new TextRun(text)] });
}
function bullet(text) {
  return new Paragraph({ numbering: { reference: "b", level: 0 }, spacing: { after: 60, line: 288 },
    children: Array.isArray(text) ? text : [new TextRun(text)] });
}
function num(text, ref) {
  return new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 60, line: 288 },
    children: Array.isArray(text) ? text : [new TextRun(text)] });
}
function headCell(t, w) {
  return new TableCell({ borders: CELL, width: { size: w, type: WidthType.DXA },
    shading: { fill: HEAD_FILL, type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: "FFFFFF", size: 20 })] })] });
}
function cell(t, w, i) {
  const runs = Array.isArray(t) ? t : [new TextRun({ text: t, size: 20 })];
  return new TableCell({ borders: CELL, width: { size: w, type: WidthType.DXA },
    shading: { fill: i % 2 ? ALT_FILL : "FFFFFF", type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ spacing: { before: 40, after: 40 }, children: runs })] });
}
function table(widths, headers, rows) {
  const trs = [new TableRow({ tableHeader: true, children: headers.map((x, i) => headCell(x, widths[i])) })];
  rows.forEach((r, ri) => trs.push(new TableRow({ children: r.map((x, ci) => cell(x, widths[ci], ri)) })));
  return new Table({ columnWidths: widths, margins: { top: 60, bottom: 60, left: 120, right: 120 }, rows: trs });
}
const R = (t, o = {}) => new TextRun({ text: t, ...o });

const children = [];

// 封面
children.push(
  new Paragraph({ spacing: { before: 1500 }, alignment: AlignmentType.CENTER,
    children: [R("内置式外部 Skill 静态安全检测方案", { bold: true, size: 52, color: "1F3864" })] }),
  new Paragraph({ spacing: { before: 120 }, alignment: AlignmentType.CENTER,
    children: [R("路线选择与设计困局说明", { size: 30, color: "555555" })] }),
  new Paragraph({ spacing: { before: 500 }, alignment: AlignmentType.CENTER,
    children: [R("面向类 Hermes 开源智能体：将检测组件内置于项目，以静态扫描为主检测外部 Skill", { size: 22, color: "888888" })] }),
  new Paragraph({ spacing: { before: 1800 }, alignment: AlignmentType.CENTER,
    children: [R("文档性质：拟采用路线说明 + 设计困局 + 待决策事项（请领导评审拍板）", { size: 22, bold: true, color: "C00000" })] }),
  new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER,
    children: [R("日期：2026-07-24", { size: 22, color: "555555" })] }),
  new Paragraph({ children: [new PageBreak()] }),
);

// 1. 背景
children.push(h("1. 背景", HeadingLevel.HEADING_1));
children.push(p("我们参与的开源项目是一个类似 Hermes 的智能体（Agent），核心能力之一是安装并调用外部 Skill 来扩展功能。外部 Skill 来源不受控（可能来自任意第三方），本质上是不可信输入，可能包含密钥窃取、危险命令、代码注入、隐蔽持久化、数据外传等风险。"));
children.push(p("为此我们计划做两个用于 Skill 安全检测的组件，随开源项目一起分发，对用户安装的外部 Skill 进行安全检测。经过权衡，我们目前倾向的路线是：将两个检测组件内置于开源项目，以静态扫描为主要检测手段。本文档说明该路线的理由、随之而来的设计困局，以及需要领导决策的事项。"));

// 2. 核心矛盾
children.push(h("2. 核心矛盾：先检测，还是先安装？", HeadingLevel.HEADING_1));
children.push(p("要检测一个外部 Skill，常规做法是先把它安装（落地）到项目里，才能读取和分析。但这带来一个先后矛盾："));
children.push(bullet([R("不可信内容先进项目再检测", { bold: true }), R(" —— 相当于「先请进门，再搜身」，外部 Skill 在被验证之前就已经进入了项目环境，风险太大。")]));
children.push(bullet([R("理想是先检测再安装", { bold: true }), R(" —— 但「检测」这一步本身要在哪里、以什么隔离级别进行，正是困局所在。")]));
children.push(p([R("进一步的关键约束：", { bold: true }),
  R("最理想的检测方式是在隔离沙箱里进行（外部 Skill 只进沙箱、不进项目，检测完不留痕）。但现实是——")]));
children.push(p([R("普通桌面用户的机器上，大概率没有沙箱环境（如 Docker）。", { bold: true, color: "C00000" }),
  R("我们不能要求用户为了用这个开源项目专门去安装并配置 Docker。这直接动摇了「沙箱检测」这一前提。")]));

// 3. 拟采用路线
children.push(h("3. 拟采用路线：内置检测组件 + 静态扫描", HeadingLevel.HEADING_1));
children.push(p([R("我们倾向的路线是：", { bold: true }),
  R("把两个检测 Skill 直接内置到开源项目中，随项目一起分发；对用户安装的外部 Skill 以静态扫描为主进行检测。")]));
children.push(p([R("为什么选它：", { bold: true }),
  R("最大优势是零配置、开箱即用，符合开源项目对普通用户的友好定位；无需用户额外部署或安装沙箱环境。")]));
children.push(p([R("关键支撑——静态扫描不需要沙箱：", { bold: true }),
  R("静态扫描只读取 Skill 文件内容做模式分析（查找密钥、危险命令、注入特征、可疑网络地址等），全程不执行外部 Skill 的代码。既然不运行它，就不存在「扫描时被外部 Skill 作恶」的风险——它的代码根本没有被执行。因此即使普通用户没有任何沙箱环境，也能安全地完成这一层检测。")]));
children.push(table([2200, 3600, 3560], ["维度", "情况", "评价"], [
  ["用户成本", "零配置，随项目自带", [R("优", { bold: true, color: "1F7A1F" })]],
  ["架构复杂度", "简单，无额外部署与维护", [R("优", { bold: true, color: "1F7A1F" })]],
  ["扫描安全性", "只读不执行，扫描过程本身无风险", [R("优", { bold: true, color: "1F7A1F" })]],
  ["检测覆盖", "覆盖静态可发现的风险（密钥/危险命令/注入/外传特征等）", [R("良", { bold: true, color: "1F7A1F" })]],
]));

// 3b. 困局
children.push(h("4. 该路线的困局：静态扫描的能力边界", HeadingLevel.HEADING_1));
children.push(p("选择内置 + 静态路线，必须如实承认它的局限——这正是需要领导知晓并认可的取舍点："));
children.push(bullet([R("拿不到动态行为分析。", { bold: true }), R("静态扫描只看代码文本，无法观测 Skill 运行时的实际行为（例如运行时才拼接的恶意命令、二进制运行时向外发送了什么）。这类风险需要在沙箱中实际运行并观测，而普通用户环境不具备沙箱。")]));
children.push(bullet([R("对二进制/混淆内容较弱。", { bold: true }), R("携带二进制文件或高度混淆代码的 Skill，静态分析能提取的信息有限。")]));
children.push(bullet([R("存在误报与漏报。", { bold: true }), R("基于规则/模式匹配，风险评级是启发式判断而非绝对结论。")]));
children.push(p([R("困局的核心：", { bold: true }),
  R("要做动态检测就需要沙箱，要沙箱就得让用户装 Docker 或另起独立组件——这与「内置、开箱即用」直接冲突。换句话说，选了简单易用，就得接受检测深度止步于静态。")]));

// 4. 对比：另一条被否的路线
children.push(h("5. 对比路线：另起独立 Agent 做检测（暂不采用）", HeadingLevel.HEADING_1));
children.push(p("作为对照，另一条路线是把检测能力独立成一个单独的 Agent 或后端服务，外部 Skill 先送去检测、通过后才下发主项目。它隔离性强、可部署沙箱做动态检测，但："));
children.push(table([2200, 3600, 3560], ["维度", "情况", "评价"], [
  ["隔离能力", "外部 Skill 不进主项目，隔离强，可部署沙箱", [R("优", { bold: true, color: "1F7A1F" })]],
  ["检测深度", "支持动态行为分析", [R("优", { bold: true, color: "1F7A1F" })]],
  ["架构复杂度", "需独立部署、服务通信、生命周期管理", [R("繁琐", { bold: true, color: "C00000" })]],
  ["用户成本", "偏离开源项目「开箱即用」，普通用户不友好", [R("高", { bold: true, color: "C00000" })]],
  ["维护成本", "多一个独立组件要维护、升级、排障", [R("高", { bold: true, color: "C00000" })]],
]));
children.push(p([R("暂不采用的理由：", { bold: true }),
  R("对一个面向普通用户的开源项目，为了检测能力多起一个独立 Agent，架构过于繁琐，部署与维护成本与项目定位不匹配。其带来的动态检测能力，目前判断不足以抵消这份复杂度。")]));

// 6. 待决策
children.push(h("6. 待决策事项（请领导拍板）", HeadingLevel.HEADING_1));
children.push(num("路线确认：是否认可「检测组件内置于开源项目 + 以静态扫描为主」作为当前路线？", "conf"));
children.push(num("安全底线：是否接受「多数普通用户只能得到静态扫描、无动态检测」这一现实？静态扫描覆盖的风险是否满足项目的安全底线？", "conf"));
children.push(num("动态检测定位：动态行为分析（尤其针对携带二进制的 Skill）是否作为后续增强项（例如为有 Docker 的高级用户提供可选深扫），而非当前必做？", "conf"));
children.push(num("对比路线取舍：是否确认暂不采用「独立 Agent 检测」路线？", "conf"));

const doc = new Document({
  creator: "wjy", title: "外部 Skill 安全检测方案",
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", run: { size: 56, bold: true, color: "1F3864", font: "Arial" },
        paragraph: { spacing: { before: 240, after: 120 }, alignment: AlignmentType.CENTER } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, color: "1F3864", font: "Arial" },
        paragraph: { spacing: { before: 260, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 25, bold: true, color: "2E5496", font: "Arial" },
        paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: "b", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 620, hanging: 300 } } } }] },
      { reference: "conf", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 620, hanging: 300 } } } }] },
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [R("外部 Skill 安全检测方案　·　第 ", { size: 18, color: "888888" }),
        new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "888888" }),
        R(" 页 / 共 ", { size: 18, color: "888888" }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: "888888" }),
        R(" 页", { size: 18, color: "888888" })] })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync("内置式外部Skill静态安全检测方案.docx", buf); console.log("生成完成"); });
