// ============ AegisBank 演示数据种子 ============
// 精心设计的数据：
//  - 消费分类有明显特征（外卖+奶茶占比高 → 账单分析有洞察）
//  - 埋入异常交易（凌晨大额、重复扣费、可疑商户 → 异常识别有产出）
//  - 订阅扣费（连续3个月同商户同金额 → 订阅自动识别可复现）
//  - 工资入账 → 月度报告收支结构完整

import { db } from "@/lib/db";

const DEMO_PHONE = "19824936641";

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function seedIfEmpty(): Promise<{ seeded: boolean; userId: string }> {
  let user = await db.user.findUnique({ where: { phone: DEMO_PHONE } });
  if (user) return { seeded: false, userId: user.id };

  user = await db.user.create({
    data: {
      phone: DEMO_PHONE,
      name: "谭畅",
      avatarEmoji: "🧑‍💼",
      riskLevel: 0,
    },
  });
  const userId = user.id;

  // ---- 账户 ----
  const account = await db.account.create({
    data: {
      userId,
      accountNo: "6217002030045678",
      type: "DEBIT",
      balance: 58201.75,
    },
  });

  // ---- 收款人 ----
  await db.payee.createMany({
    data: [
      { userId, name: "王秀兰", remark: "妈妈", phone: "13907112233", accountNo: "6222020011223344", bank: "工商银行", frequent: 21 },
      { userId, name: "张伟", remark: "室友", phone: "15820445566", accountNo: "6217009988776655", bank: "微众银行", frequent: 18 },
      { userId, name: "李娜", remark: "同学", phone: "18677889900", accountNo: "6225881122334455", bank: "招商银行", frequent: 9 },
      { userId, name: "王国强", remark: "房东", phone: "13711223344", accountNo: "6212230044556677", bank: "建设银行", frequent: 6 },
      { userId, name: "谭建军", remark: "爸爸", phone: "13607115588", accountNo: "6222020055667788", bank: "工商银行", frequent: 5 },
    ],
  });

  // ---- 理财产品 ----
  const products = await Promise.all([
    db.financeProduct.create({
      data: {
        code: "CASH001",
        name: "活期+",
        type: "CASHPLUS",
        riskLevel: 1,
        minAmount: 0.01,
        expectedRet: 2.35,
        lockDays: 0,
        tags: "随时可取,现金管理",
        desc: "现金管理类，申购赎回实时到账，适合放置日常备用金",
      },
    }),
    db.financeProduct.create({
      data: {
        code: "FIX090",
        name: "稳利90天",
        type: "FIXED",
        riskLevel: 2,
        minAmount: 1000,
        expectedRet: 3.05,
        lockDays: 90,
        remainQuota: 500000,
        tags: "固定期限,到期自动赎回",
        desc: "90天定期固收，中低风险，适合稳健型资金",
      },
    }),
    db.financeProduct.create({
      data: {
        code: "FIX180",
        name: "智选180天",
        type: "FIXED",
        riskLevel: 3,
        minAmount: 5000,
        expectedRet: 3.65,
        lockDays: 180,
        remainQuota: 200000,
        tags: "固收增强",
        desc: "180天固收增强，配置少量高等级信用债增强收益",
      },
    }),
    db.financeProduct.create({
      data: {
        code: "FUND301",
        name: "沪深300指数基金",
        type: "FUND",
        riskLevel: 4,
        minAmount: 100,
        expectedRet: 6.8,
        lockDays: 0,
        tags: "指数基金,波动较大",
        desc: "跟踪沪深300指数，长期定投分散入场",
      },
    }),
    db.financeProduct.create({
      data: {
        code: "GOLD01",
        name: "黄金积存金",
        type: "FUND",
        riskLevel: 3,
        minAmount: 100,
        expectedRet: 5.2,
        lockDays: 0,
        tags: "抗通胀,克为单位",
        desc: "按克积存黄金，可赎回现金或提取实物",
      },
    }),
  ]);

  // ---- 理财持仓（活期+ 20000 已持有45天，有预估收益） ----
  await db.holding.create({
    data: {
      userId,
      productId: products[0].id,
      amount: 20000,
      confirmedAt: new Date(Date.now() - 45 * 24 * 3600 * 1000),
      redeemable: new Date(),
    },
  });

  // ---- 卡片 ----
  await db.card.createMany({
    data: [
      {
        userId,
        cardNo: "6217002030045678",
        type: "DEBIT",
        label: "主力卡",
        status: "ACTIVE",
        limitDay: 20000,
        limitOnline: true,
        limitAbroad: false,
      },
      {
        userId,
        cardNo: "6225887700123345",
        type: "VIRTUAL",
        label: "网购虚拟卡",
        status: "ACTIVE",
        limitDay: 3000,
        limitOnline: true,
        limitAbroad: false,
        quota: 3000,
      },
    ],
  });

  // ---- 交易流水（近 120 天，覆盖订阅/异常/消费结构） ----
  const txs: Parameters<typeof db.transaction.createMany>[0]["data"] = [];
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;

  // 工资（每月10日）
  for (let m = 3; m >= 1; m--) {
    const d = new Date(now - m * 30 * DAY);
    d.setDate(10);
    txs.push({
      userId,
      accountId: account.id,
      type: "SALARY",
      amount: 3200,
      direction: "IN",
      category: "工资",
      merchant: "大连前程科技（实习工资）",
      occurredAt: d,
      status: "SUCCESS",
    });
  }
  // 生活费（每月1日，妈妈转入）
  for (let m = 3; m >= 1; m--) {
    const d = new Date(now - m * 30 * DAY);
    d.setDate(1);
    txs.push({
      userId,
      accountId: account.id,
      type: "TRANSFER_IN",
      amount: 2000,
      direction: "IN",
      category: "转账",
      merchant: "王秀兰（妈妈）",
      counterparty: "3344",
      occurredAt: d,
      status: "SUCCESS",
    });
  }

  // 订阅扣费（连续 3 个月同商户同金额 → detectSubscriptions 可识别）
  const subs: { merchant: string; amount: number; day: number; category: string }[] = [
    { merchant: "爱奇艺VIP", amount: 25, day: 5, category: "订阅" },
    { merchant: "网易云音乐", amount: 15, day: 8, category: "订阅" },
    { merchant: "iCloud云存储", amount: 21, day: 12, category: "订阅" },
    { merchant: "美团外卖会员", amount: 15, day: 18, category: "订阅" },
  ];
  for (const s of subs) {
    for (let m = 3; m >= 1; m--) {
      const d = new Date(now - m * 30 * DAY);
      d.setDate(s.day);
      txs.push({
        userId,
        accountId: account.id,
        type: "SUBSCRIPTION",
        amount: s.amount,
        direction: "OUT",
        category: s.category,
        merchant: s.merchant,
        occurredAt: d,
        status: "SUCCESS",
      });
    }
  }

  // 日常消费（每天 1-4 笔）
  const CATS: { cat: string; merchants: string[]; min: number; max: number; weight: number }[] = [
    { cat: "餐饮", merchants: ["美团外卖", "饿了么", "大学城食堂", "蜜雪冰城", "瑞幸咖啡", "海底捞"], min: 9, max: 180, weight: 40 },
    { cat: "购物", merchants: ["京东商城", "淘宝", "拼多多", "屈臣氏"], min: 30, max: 600, weight: 15 },
    { cat: "交通", merchants: ["滴滴出行", "地铁扫码", "公交集团"], min: 2, max: 45, weight: 12 },
    { cat: "娱乐", merchants: ["猫眼电影", "KTV", "Steam", "网吧"], min: 30, max: 200, weight: 8 },
    { cat: "居住", merchants: ["国家电网", "自来水公司", "移动话费"], min: 30, max: 120, weight: 6 },
    { cat: "教育", merchants: ["当当书店", "中国知网", "打印店"], min: 10, max: 80, weight: 4 },
    { cat: "医疗", merchants: ["大药房", "校医院"], min: 15, max: 150, weight: 3 },
  ];
  for (let day = 118; day >= 0; day--) {
    const n = Math.random() < 0.25 ? 0 : 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      // 加权选类
      const totalW = CATS.reduce((s, c) => s + c.weight, 0);
      let r = Math.random() * totalW;
      let cat = CATS[0];
      for (const c of CATS) {
        r -= c.weight;
        if (r <= 0) {
          cat = c;
          break;
        }
      }
      const d = new Date(now - day * DAY + Math.floor(rand(8, 22)) * 3600 * 1000);
      txs.push({
        userId,
        accountId: account.id,
        type: "PURCHASE",
        amount: Number(rand(cat.min, cat.max).toFixed(2)),
        direction: "OUT",
        category: cat.cat,
        merchant: pick(cat.merchants),
        occurredAt: d,
        status: "SUCCESS",
      });
    }
  }

  // ---- 刻意埋入的异常交易 ----
  // A1 凌晨大额（R1 夜间交易）
  const night = new Date(now - 6 * DAY);
  night.setHours(3, 12, 0, 0);
  txs.push({
    userId,
    accountId: account.id,
    type: "PURCHASE",
    amount: 1280,
    direction: "OUT",
    category: "购物",
    merchant: "某电商平台自营",
    occurredAt: night,
    status: "SUCCESS",
  });
  // A2 大额偏离（R2）
  txs.push({
    userId,
    accountId: account.id,
    type: "PURCHASE",
    amount: 3999,
    direction: "OUT",
    category: "购物",
    merchant: "京东商城",
    occurredAt: new Date(now - 9 * DAY),
    status: "SUCCESS",
  });
  // A3 重复扣费（R3：24小时内同商户同金额2笔）
  txs.push({
    userId,
    accountId: account.id,
    type: "SUBSCRIPTION",
    amount: 68,
    direction: "OUT",
    category: "订阅",
    merchant: "某视频平台",
    occurredAt: new Date(now - 2 * DAY - 10 * 3600 * 1000),
    status: "SUCCESS",
  });
  txs.push({
    userId,
    accountId: account.id,
    type: "SUBSCRIPTION",
    amount: 68,
    direction: "OUT",
    category: "订阅",
    merchant: "某视频平台",
    occurredAt: new Date(now - 2 * DAY - 3 * 3600 * 1000),
    status: "SUCCESS",
  });
  // A4 可疑商户（R4 黑名单）
  txs.push({
    userId,
    accountId: account.id,
    type: "PURCHASE",
    amount: 520,
    direction: "OUT",
    category: "其他",
    merchant: "XX跨境博彩平台",
    occurredAt: new Date(now - 4 * DAY),
    status: "SUCCESS",
  });

  // ---- 历史转账（对妈妈转账记录，日常累计数据） ----
  txs.push({
    userId,
    accountId: account.id,
    type: "TRANSFER_OUT",
    amount: 500,
    direction: "OUT",
    category: "转账",
    merchant: "王秀兰（妈妈）",
    counterparty: "3344",
    remark: "母亲节红包",
    occurredAt: new Date(now - 40 * DAY),
    status: "SUCCESS",
  });
  txs.push({
    userId,
    accountId: account.id,
    type: "TRANSFER_OUT",
    amount: 200,
    direction: "OUT",
    category: "转账",
    merchant: "张伟（室友）",
    counterparty: "6655",
    remark: "聚餐AA",
    occurredAt: new Date(now - 12 * DAY),
    status: "SUCCESS",
  });

  await db.transaction.createMany({ data: txs });

  // ---- 订阅表预登记（订阅识别场景用） ----
  await db.subscription.createMany({
    data: [
      { userId, merchant: "爱奇艺VIP", category: "视频会员", amount: 25, cycle: "MONTHLY", nextCharge: nextM(5), detected: true },
      { userId, merchant: "网易云音乐", category: "音乐会员", amount: 15, cycle: "MONTHLY", nextCharge: nextM(8), detected: true },
      { userId, merchant: "iCloud云存储", category: "云存储", amount: 21, cycle: "MONTHLY", nextCharge: nextM(12), detected: true },
      { userId, merchant: "美团外卖会员", category: "外卖", amount: 15, cycle: "MONTHLY", nextCharge: nextM(18), detected: true },
    ],
  });

  // ---- 默认会话 ----
  await db.chatSession.create({ data: { userId, title: "AegisBank 智能助手" } });

  return { seeded: true, userId };
}

function nextM(day: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(day);
  return d;
}
