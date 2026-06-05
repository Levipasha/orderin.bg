import PDFDocument from 'pdfkit';

/**
 * Generates a highly professional PDF Invoice as a Buffer using PDFKit.
 * 
 * @param {Object} data Invoice details
 * @returns {Promise<Buffer>} Resolves to a PDF document Buffer
 */
export function generateInvoicePdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // ── COLOR PALETTE ──
      const primaryColor = '#bd3838'; // Crimson Brand Accent
      const secondaryColor = '#0f172a'; // Deep slate
      const darkColor = '#1e293b'; // Charcoal
      const lightColor = '#f8fafc'; // Off-white
      const borderLineColor = '#cbd5e1'; // Light grey

      // ── HEADER SECTION ──
      // Brand Logo Placeholder (Draw a gorgeous vector shield/hamburger icon)
      doc.rect(50, 45, 40, 40).fill(primaryColor);
      doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold').text('O', 64, 56);
      
      // Platform Brand Title
      doc.fillColor(secondaryColor).fontSize(20).font('Helvetica-Bold').text('Orderin', 100, 50);
      doc.fontSize(8).font('Helvetica').fillColor('#64748b').text('PREMIUM ORDERING & SAAS MARKETPLACE', 100, 72);

      // Corporate Info (Top Right)
      doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text('SkyWeb IT Solutions Private Ltd.', 360, 50, { align: 'right' });
      doc.font('Helvetica').fillColor('#475569')
         .text('GF, Marketplace Plaza, IT Corridor', 360, 62, { align: 'right' })
         .text('Hyderabad, Telangana, 500081, India', 360, 74, { align: 'right' })
         .text('GSTIN: 36AABCS4818R1Z1', 360, 86, { align: 'right' });

      // Horizontal separator line
      doc.moveTo(50, 110).lineTo(545, 110).strokeColor(borderLineColor).lineWidth(1).stroke();

      // ── INVOICE METRICS ROW ──
      doc.font('Helvetica-Bold').fontSize(14).fillColor(primaryColor).text('TAX INVOICE', 50, 125);
      
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Invoice No:', 50, 150);
      doc.font('Helvetica-Bold').fillColor(darkColor).text(data.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`, 110, 150);

      doc.font('Helvetica').fillColor('#64748b').text('Billing Date:', 50, 165);
      doc.font('Helvetica-Bold').fillColor(darkColor).text(data.paymentDate ? new Date(data.paymentDate).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN'), 110, 165);

      doc.font('Helvetica').fillColor('#64748b').text('Transaction ID:', 250, 150);
      doc.font('Helvetica-Bold').fillColor(darkColor).text(data.transactionId || 'N/A', 330, 150);

      doc.font('Helvetica').fillColor('#64748b').text('Order ID:', 250, 165);
      doc.font('Helvetica-Bold').fillColor(darkColor).text(data.orderId || 'N/A', 330, 165);

      // ── BILLING CUSTOMER DETAILS ──
      doc.rect(50, 195, 495, 65).fill(lightColor);
      doc.rect(50, 195, 495, 65).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

      doc.fillColor(primaryColor).font('Helvetica-Bold').fontSize(9).text('BILLED TO (CUSTOMER):', 65, 205);
      
      doc.fillColor(secondaryColor).fontSize(10).font('Helvetica-Bold').text(data.customerName || 'N/A', 65, 220);
      doc.font('Helvetica').fontSize(9).fillColor('#475569')
         .text(`Email: ${data.customerEmail || 'N/A'}`, 65, 233)
         .text(`Payment Gateway Mode: ${data.paymentMethod ? data.paymentMethod.toUpperCase() : 'RAZORPAY_SECURE'}`, 280, 233);

      // ── ITEM DESCRIPTION TABLE ──
      let tableTop = 285;
      
      // Table Header
      doc.rect(50, tableTop, 495, 25).fill(secondaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
         .text('Product / Plan Details', 65, tableTop + 8)
         .text('Billing Cycle', 280, tableTop + 8)
         .text('Taxable Value', 390, tableTop + 8, { width: 70, align: 'right' })
         .text('Total (INR)', 470, tableTop + 8, { width: 60, align: 'right' });

      // Table Row
      let rowTop = tableTop + 25;
      doc.rect(50, rowTop, 495, 40).fill('#ffffff');
      doc.rect(50, rowTop, 495, 40).strokeColor('#f1f5f9').lineWidth(1).stroke();

      doc.fillColor(darkColor).font('Helvetica-Bold').fontSize(10)
         .text(data.planName || 'Premium Pro subscription', 65, rowTop + 10);
      doc.font('Helvetica').fontSize(8.5).fillColor('#64748b')
         .text('Comprehensive SaaS dashboard access with automated tableside QR ordering systems', 65, rowTop + 22);

      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(darkColor)
         .text('Monthly', 280, rowTop + 15)
         .text(`₹${(data.amountPaid - (data.gstAmount || 0)).toFixed(2)}`, 390, rowTop + 15, { width: 70, align: 'right' })
         .text(`₹${parseFloat(data.amountPaid).toFixed(2)}`, 470, rowTop + 15, { width: 60, align: 'right' });

      // ── TAX BREAKDOWN SUMMARY ──
      let breakdownTop = rowTop + 65;

      doc.font('Helvetica').fontSize(9.5).fillColor('#64748b').text('Subtotal (Taxable Value):', 300, breakdownTop);
      doc.font('Helvetica-Bold').fillColor(darkColor).text(`₹${(data.amountPaid - (data.gstAmount || 0)).toFixed(2)}`, 470, breakdownTop, { width: 60, align: 'right' });

      doc.font('Helvetica').fillColor('#64748b').text('Integrated GST (18.00%):', 300, breakdownTop + 18);
      doc.font('Helvetica-Bold').fillColor(darkColor).text(`₹${parseFloat(data.gstAmount || 0).toFixed(2)}`, 470, breakdownTop + 18, { width: 60, align: 'right' });

      doc.font('Helvetica').fillColor('#64748b').text('Convenience / Platform Fee:', 300, breakdownTop + 36);
      doc.font('Helvetica-Bold').fillColor(darkColor).text('₹0.00', 470, breakdownTop + 36, { width: 60, align: 'right' });

      // Final Total Box
      doc.rect(290, breakdownTop + 55, 255, 30).fill(primaryColor);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
         .text('TOTAL PAID:', 300, breakdownTop + 65)
         .text(`₹${parseFloat(data.amountPaid).toFixed(2)}`, 450, breakdownTop + 65, { width: 80, align: 'right' });

      // ── FOOTER & DISCLOSURE ──
      doc.font('Helvetica').fontSize(8.5).fillColor('#64748b')
         .text('TERMS & CONDITIONS', 50, tableTop + 240, { font: 'Helvetica-Bold' })
         .text('This invoice is computer-generated and electronically issued. No physical signature is required. All digital subscription fees paid are non-refundable.', 50, tableTop + 252, { width: 495, lineGap: 3 });

      doc.moveTo(50, tableTop + 295).lineTo(545, tableTop + 295).strokeColor(borderLineColor).lineWidth(0.5).stroke();

      doc.fontSize(8).fillColor('#94a3b8')
         .text('Powered by SkyWeb IT Solutions Private Limited. Support: support@orderin.com', 50, tableTop + 310, { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
