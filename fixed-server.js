// KR Property Backend Server - Inflation Calculator Only
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { neon } = require("@neondatabase/serverless");
const { drizzle } = require("drizzle-orm/neon-http");
const {
  pgTable,
  text,
  serial,
  timestamp,
  numeric,
  integer,
} = require("drizzle-orm/pg-core");
const { eq, and } = require("drizzle-orm");
const sgMail = require("@sendgrid/mail");

// Environment variables from .env file
const DATABASE_URL = process.env.DATABASE_URL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const PORT = process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || "development";

console.log("🔧 Environment variables loaded from .env");
console.log("📊 DATABASE_URL:", DATABASE_URL ? "✅ Configured" : "❌ Missing");
console.log(
  "📧 SENDGRID_API_KEY:",
  SENDGRID_API_KEY ? "✅ Configured" : "❌ Missing"
);
console.log("🌍 NODE_ENV:", NODE_ENV);
console.log("🔗 PORT:", PORT);

const app = express();

// Configure SendGrid
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log("✅ SendGrid configured");
} else {
  console.log("⚠️ SendGrid not configured");
}

// Database setup
let db = null;
let sql = null;

try {
  if (DATABASE_URL) {
    sql = neon(DATABASE_URL);
    db = drizzle(sql);
    console.log("✅ Database connection initialized");
  } else {
    console.log("⚠️ No DATABASE_URL found");
  }
} catch (error) {
  console.error("❌ Database initialization failed:", error);
}

// Table schemas - Only inflation related tables
const inflationCalculations = pgTable("inflation_calculations", {
  id: serial("id").primaryKey(),
  initialAmount: numeric("initial_amount").notNull(),
  years: integer("years").notNull(),
  inflationRate: numeric("inflation_rate").notNull(),
  finalAmount: numeric("final_amount").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Pending emails table for failed email attempts
const pendingEmails = pgTable("pending_emails", {
  id: serial("id").primaryKey(),
  recipientEmail: text("recipient_email").notNull(),
  recipientName: text("recipient_name"),
  subject: text("subject").notNull(),
  htmlContent: text("html_content").notNull(),
  emailType: text("email_type").notNull(), // 'inflation_report'
  status: text("status").default("pending").notNull(), // 'pending', 'sent', 'failed'
  errorDetails: text("error_details"),
  attempts: integer("attempts").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
});

// Middleware - Simplified CORS configuration
app.use(
  cors({
    origin: "*", // Allow all origins since no credentials are sent
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    optionsSuccessStatus: 200,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ========================================
// ROOT AND TEST ROUTES
// ========================================

// Root route for easy testing
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "KR Property Inflation Calculator API is running! 🚀",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: db ? "Connected" : "Not connected",
    email: SENDGRID_API_KEY ? "Configured" : "Not configured",
    endpoints: {
      health: "/health",
      test: "/api/test",
      inflation: "/api/inflation",
      inflationEmail: "/api/inflation-email",
    },
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "KR Property Inflation Calculator API is healthy! 🏥",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    database: db ? "Connected" : "Not connected",
    email: SENDGRID_API_KEY ? "Configured" : "Not configured",
  });
});

// Create tables function
async function createTables() {
  if (!sql) {
    console.log("⚠️ Cannot create tables - no database connection");
    return false;
  }

  try {
    console.log("🔧 Creating database tables...");

    await sql`CREATE TABLE IF NOT EXISTS inflation_calculations (
      id SERIAL PRIMARY KEY,
      initial_amount NUMERIC NOT NULL,
      years INTEGER NOT NULL,
      inflation_rate NUMERIC NOT NULL,
      final_amount NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

    // Pending emails table
    await sql`CREATE TABLE IF NOT EXISTS pending_emails (
      id SERIAL PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      subject TEXT NOT NULL,
      html_content TEXT NOT NULL,
      email_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending' NOT NULL,
      error_details TEXT,
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      sent_at TIMESTAMP
    )`;

    console.log("✅ All database tables created successfully");
    return true;
  } catch (error) {
    console.error("❌ Failed to create tables:", error);
    return false;
  }
}

// Test endpoint
app.get("/api/test", async (req, res) => {
  try {
    const result = {
      success: true,
      message: "KR Property Inflation Calculator API is working!",
      timestamp: new Date().toISOString(),
      database: db ? "connected" : "not connected",
      email: SENDGRID_API_KEY ? "configured" : "not configured",
    };

    if (db && sql) {
      try {
        const testQuery = await sql`SELECT NOW() as current_time`;
        result.databaseTest = {
          success: true,
          time: testQuery[0].current_time,
          message: "Database connection successful",
        };
      } catch (dbError) {
        result.databaseTest = {
          success: false,
          error: dbError.message,
        };
      }
    }

    res.json(result);
  } catch (error) {
    console.error("❌ Test endpoint error:", error);
    res.status(500).json({
      success: false,
      message: "Test endpoint failed",
      error: error.message,
    });
  }
});

// ========================================
// INFLATION CALCULATOR ENDPOINTS
// ========================================

// Inflation calculator endpoint
app.post("/api/inflation", async (req, res) => {
  try {
    console.log("📊 Inflation calculation request:", req.body);

    const { name, email, amount, year, month, source } = req.body;

    // Validate required fields
    if (!amount || !year || !month) {
      return res.status(400).json({
        success: false,
        message: "Amount, year, and month are required",
      });
    }

    // Parse and validate numeric inputs
    const initialAmount = parseFloat(amount);
    const startYear = parseInt(year);
    const startMonth = parseInt(month);
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;

    if (isNaN(initialAmount) || isNaN(startYear) || isNaN(startMonth)) {
      return res.status(400).json({
        success: false,
        message: "Invalid numeric values provided",
      });
    }

    if (initialAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be positive",
      });
    }

    // Calculate years difference
    const yearsDiff =
      currentYear - startYear + (currentMonth - startMonth) / 12;

    // Use UK average inflation rate (approximately 2.5% per year)
    const inflationRate = 2.5;

    // Calculate inflation impact
    const finalAmount =
      initialAmount * Math.pow(1 + inflationRate / 100, yearsDiff);
    const totalIncrease = finalAmount - initialAmount;
    const percentageIncrease = (totalIncrease / initialAmount) * 100;

    console.log(
      `💰 Calculation: £${initialAmount} from ${startYear}-${startMonth} -> £${finalAmount.toFixed(
        2
      )} today (${yearsDiff.toFixed(1)} years)`
    );

    // Save calculation to database if available
    if (db) {
      try {
        const calculationData = {
          initialAmount: initialAmount.toString(),
          years: Math.floor(yearsDiff),
          inflationRate: inflationRate.toString(),
          finalAmount: finalAmount.toString(),
        };

        const result = await db
          .insert(inflationCalculations)
          .values(calculationData)
          .returning();

        console.log("✅ Inflation calculation saved with ID:", result[0].id);
      } catch (dbError) {
        console.error("⚠️ Failed to save calculation to database:", dbError);
        // Continue without failing the request
      }
    }

    res.json({
      success: true,
      message: "Inflation calculation completed successfully",
      data: {
        originalValue: initialAmount,
        todayValue: parseFloat(finalAmount.toFixed(2)),
        lossInValue: parseFloat(totalIncrease.toFixed(2)),
        percentageIncrease: parseFloat(percentageIncrease.toFixed(2)),
        annualGrowthRate: inflationRate,
        startYear: startYear,
        endYear: currentYear,
        yearsDiff: parseFloat(yearsDiff.toFixed(1)),
        calculatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("❌ Inflation calculation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to calculate inflation",
      error: error.message,
    });
  }
});

// Inflation email endpoint
app.post("/api/inflation-email", async (req, res) => {
  try {
    console.log("📧 Inflation email request:", {
      name: req.body.name,
      email: req.body.email,
      hasChartImage: !!req.body.chartImage,
      hasCalculationData: !!req.body.calculationData,
    });

    const { name, email, amount, month, year, chartImage, calculationData } =
      req.body;

    // Validate required fields
    if (!email || !calculationData) {
      return res.status(400).json({
        success: false,
        message: "Email and calculation data are required",
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    // Send email with SendGrid
    let emailSent = false;
    let emailError = null;
    let emailStored = false;

    if (SENDGRID_API_KEY) {
      try {
        console.log("📧 Sending inflation report email...");

        const emailContent = `
          <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #333;">
            
            <div style="text-align: left; margin-bottom: 30px; border-bottom: 2px solid #ddd; padding-bottom: 15px;">
              <h1 style="color: #008e6d; margin: 0; font-size: 24px; font-weight: bold;">KR Property Investments</h1>
              <p style="margin: 5px 0 0 0; font-size: 16px; color: #666;">Your Inflation Impact Report</p>
            </div>
            
            <p style="margin-bottom: 20px;">Hello ${name || "there"},</p>
            
            <p style="margin-bottom: 25px;">Thank you for using our Inflation Calculator. Here's your detailed inflation impact analysis:</p>
            
            <div style="border-top: 2px solid #ddd; margin: 30px 0 20px 0;"></div>
            
            <div style="margin: 30px 0;">
              <h2 style="color: #008e6d; margin: 0 0 20px 0; font-size: 20px;">📊 Calculation Summary</h2>
              <ul style="list-style: none; padding: 0; margin: 0;">
                <li style="margin-bottom: 8px;">• <strong>Original Amount:</strong> £${
                  amount?.toLocaleString() ||
                  calculationData.originalValue?.toLocaleString()
                }</li>
                <li style="margin-bottom: 8px;">• <strong>From:</strong> ${month}/${year}</li>
                <li style="margin-bottom: 8px;">• <strong>Today's Value:</strong> £${calculationData.todayValue?.toLocaleString()}</li>
                <li style="margin-bottom: 8px;">• <strong>Loss in Purchasing Power:</strong> £${calculationData.lossInValue?.toLocaleString()}</li>
                <li style="margin-bottom: 8px;">• <strong>Percentage Increase Needed:</strong> ${calculationData.percentageIncrease?.toFixed(
                  2
                )}%</li>
              </ul>
            </div>

            ${
              chartImage
                ? `
            <div style="margin: 30px 0;">
              <h2 style="color: #008e6d; margin: 0 0 20px 0; font-size: 20px;">📊 Visual Impact</h2>
              <div style="text-align: center; margin: 20px 0;">
                <img src="${chartImage}" alt="Inflation Impact Chart" style="max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 8px;" />
                <p style="font-size: 12px; color: #666; margin-top: 10px; font-style: italic;">
                  Visual comparison showing your original amount versus what you would need today to have the same purchasing power.
                </p>
              </div>
            </div>
            `
                : ""
            }

            <div style="margin: 30px 0;">
              <h2 style="color: #008e6d; margin: 0 0 20px 0; font-size: 20px;">💡 Key Insight</h2>
              <p style="margin-bottom: 15px;">Your money has lost <strong>${calculationData.percentageIncrease?.toFixed(
                2
              )}%</strong> of its purchasing power due to inflation. To maintain the same buying power, you would need <strong>£${calculationData.todayValue?.toLocaleString()}</strong> today.</p>
              <p style="margin-bottom: 15px; font-style: italic; background-color: #f8f9fa; padding: 15px; border-left: 4px solid #008e6d;">"Not investing is like pouring water into a leaky bucket. Over time, no matter how full it looks, you're left with much less than you started with."</p>
            </div>

            <div style="margin: 30px 0;">
              <h2 style="color: #008e6d; margin: 0 0 20px 0; font-size: 20px;">🚀 What This Means for You</h2>
              <p style="margin-bottom: 15px;">Inflation silently erodes your savings. Consider investing in assets that can outpace inflation, such as:</p>
              <ul style="margin-bottom: 15px;">
                <li>Property investments</li>
                <li>Stock market funds</li>
                <li>Inflation-protected securities</li>
              </ul>
            </div>

            <div style="margin: 30px 0;">
              <h2 style="color: #008e6d; margin: 0 0 20px 0; font-size: 20px;">📞 Let's Talk</h2>
              <p style="margin-bottom: 15px;">Want to find out how to protect your money and grow it confidently?</p>
              
              <div style="text-align: center; margin: 25px 0;">
                <a href="https://kr-properties.co.uk/contact" style="display: inline-block; background-color: #008e6d; color: white; text-decoration: none; padding: 15px 30px; border-radius: 5px; font-weight: bold; font-size: 16px;">Book a Personal Consultation →</a>
              </div>
              
              <p style="margin-bottom: 5px;">Or contact us directly:</p>
              <p style="margin: 5px 0;"><strong>Email:</strong> info@kr-properties.co.uk</p>
              <p style="margin: 5px 0;"><strong>Phone:</strong> 020 3633 2783</p>
            </div>

            <div style="border-top: 2px solid #ddd; margin: 30px 0 20px 0;"></div>
            
            <div style="text-align: center; color: #666; font-size: 12px; margin-top: 30px;">
              <p style="margin: 0;">© ${new Date().getFullYear()} KR Property Investments. All rights reserved.</p>
            </div>
          </div>
        `;

        // Try multiple sender configurations
        const senderConfigs = [
          {
            from: "info@kr-properties.co.uk",
            name: "KR Property Investments",
          },
          {
            from: "noreply@kr-properties.co.uk",
            name: "KR Property Investments",
          },
          {
            from: "hello@kr-properties.co.uk",
            name: "KR Property Investments",
          },
        ];

        for (const config of senderConfigs) {
          try {
            console.log(`📧 Attempting to send with sender: ${config.from}`);

            const msg = {
              to: email.trim(),
              from: {
                email: config.from,
                name: config.name,
              },
              subject: "Your Inflation Impact Report - KR Property Investments",
              html: emailContent,
            };

            await sgMail.send(msg);
            emailSent = true;
            console.log(
              `✅ Inflation email sent successfully using ${config.from}`
            );
            break; // Exit loop on success
          } catch (configError) {
            console.error(
              `❌ Failed with ${config.from}:`,
              configError.message
            );
            emailError = configError;
            continue; // Try next config
          }
        }

        if (!emailSent) {
          console.error("❌ All sender configurations failed");
          console.error("❌ Final SendGrid Error:", emailError);

          // Store email content in database for later processing
          if (db) {
            try {
              await db.insert(pendingEmails).values({
                recipientEmail: email.trim(),
                recipientName: name || "User",
                subject:
                  "Your Inflation Impact Report - KR Property Investments",
                htmlContent: emailContent,
                emailType: "inflation_report",
                status: "pending",
                errorDetails: emailError
                  ? JSON.stringify({
                      message: emailError.message,
                      code: emailError.code,
                      response: emailError.response?.body,
                    })
                  : "SendGrid configuration issue",
              });
              emailStored = true;
              console.log(
                "💾 Email content stored in database for later processing"
              );
            } catch (dbError) {
              console.error("❌ Failed to store email in database:", dbError);
            }
          }
        }
      } catch (emailError) {
        console.error("❌ Failed to send inflation email:", emailError);
        console.error("❌ SendGrid Error Details:", {
          code: emailError.code,
          message: emailError.message,
          response: emailError.response?.body,
        });
        emailSent = false;
      }
    } else {
      console.log("⚠️ SendGrid not configured - skipping email");
    }

    res.json({
      success: true,
      message: "Inflation email processed successfully",
      data: {
        emailSent,
        emailStored,
        recipient: email.trim(),
        timestamp: new Date().toISOString(),
        errorDetails: emailError
          ? {
              message: emailError.message,
              code: emailError.code,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("❌ Inflation email error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process inflation email",
      error: error.message,
    });
  }
});

// ========================================
// SERVER STARTUP
// ========================================

async function startServer() {
  try {
    // Create database tables
    if (db) {
      await createTables();
    }

    // Start the server
    app.listen(PORT, () => {
      console.log("🚀 KR Property Inflation Calculator API server started!");
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`🔗 Server running on port ${PORT}`);
      console.log(`📊 Database: ${db ? "Connected" : "Not connected"}`);
      console.log(
        `📧 Email: ${SENDGRID_API_KEY ? "Configured" : "Not configured"}`
      );
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`🔗 API test: http://localhost:${PORT}/api/test`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

module.exports = app;
