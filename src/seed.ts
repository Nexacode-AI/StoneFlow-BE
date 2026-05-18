import 'dotenv/config';
import prisma from './lib/prisma';

async function seed() {
  console.log('🌱 Seeding database...');

  // Create users
  const users = await Promise.all([
    prisma.user.upsert({
      where: { phone: '+60123456789' },
      update: {},
      create: {
        name: 'Ahmad Razak',
        phone: '+60123456789',
        email: 'admin@stoneco.com',
        role: 'ADMIN',
        language: 'BAHASA_MALAY',
      },
    }),
    prisma.user.upsert({
      where: { phone: '+60198887766' },
      update: {},
      create: {
        name: 'Raju Kumar',
        phone: '+60198887766',
        role: 'CUTTER',
        language: 'TAMIL',
      },
    }),
    prisma.user.upsert({
      where: { phone: '+60177654321' },
      update: {},
      create: {
        name: 'Wei Ming',
        phone: '+60177654321',
        role: 'POLISHER',
        language: 'MANDARIN',
      },
    }),
    prisma.user.upsert({
      where: { phone: '+60112223344' },
      update: {},
      create: {
        name: 'Rahim Hossain',
        phone: '+60112223344',
        role: 'EDGE_FINISHER',
        language: 'BANGLA',
      },
    }),
    prisma.user.upsert({
      where: { phone: '+60155443322' },
      update: {},
      create: {
        name: 'James Lim',
        phone: '+60155443322',
        role: 'INSTALLER',
        language: 'ENGLISH',
      },
    }),
    prisma.user.upsert({
      where: { phone: '+60144556677' },
      update: {},
      create: {
        name: 'Siti Noraini',
        phone: '+60144556677',
        role: 'QC_INSPECTOR',
        language: 'BAHASA_MALAY',
      },
    }),
  ]);

  console.log(`✅ Created ${users.length} users`);

  // Create workflow template
  await prisma.workflowTemplate.upsert({
    where: { id: 'default-granite-template' },
    update: {},
    create: {
      id: 'default-granite-template',
      name: 'Standard Granite Countertop',
      description: 'Full workflow for granite kitchen/bathroom countertop orders',
      isDefault: true,
      steps: [
        { stepNumber: 1, name: 'Cutting', description: 'Cut granite slab to measurements' },
        { stepNumber: 2, name: 'Polishing', description: 'Polish surface to required finish' },
        { stepNumber: 3, name: 'Edge Finishing', description: 'Shape and finish edges' },
        { stepNumber: 4, name: 'QC Inspection', description: 'Quality check before packing' },
        { stepNumber: 5, name: 'Packing', description: 'Wrap and pack for delivery' },
        { stepNumber: 6, name: 'Loading & Delivery', description: 'Load onto vehicle and deliver' },
        { stepNumber: 7, name: 'Installation', description: 'Install at customer site, upload photos' },
      ],
    },
  });

  // Create sample jobs
  const job1 = await prisma.job.create({
    data: {
      jobNumber: 'JOB-2026-1001',
      title: 'Black Granite Kitchen Countertop',
      clientName: 'John Smith',
      clientPhone: '+60122334455',
      material: 'Black Granite',
      color: 'Jet Black',
      measurements: '3200mm x 600mm x 20mm',
      deadline: new Date('2026-05-30'),
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      totalSteps: 6,
      completedSteps: 2,
      workflowSteps: {
        create: [
          { stepNumber: 1, name: 'Cutting', description: 'Cut to 3200x600mm', assignedUserId: users[1].id, status: 'COMPLETED', startedAt: new Date('2026-05-17T08:00:00'), completedAt: new Date('2026-05-17T10:00:00') },
          { stepNumber: 2, name: 'Polishing', description: 'Mirror finish required', assignedUserId: users[2].id, status: 'COMPLETED', startedAt: new Date('2026-05-17T10:05:00'), completedAt: new Date('2026-05-17T13:00:00') },
          { stepNumber: 3, name: 'Edge Finishing', description: 'Bullnose edge profile', assignedUserId: users[3].id, status: 'IN_PROGRESS', startedAt: new Date('2026-05-17T13:10:00') },
          { stepNumber: 4, name: 'QC Inspection', description: 'Full quality check', assignedUserId: users[5].id, status: 'WAITING' },
          { stepNumber: 5, name: 'Packing', description: 'Wrap securely', status: 'WAITING' },
          { stepNumber: 6, name: 'Installation', description: 'Install and photo upload', assignedUserId: users[4].id, status: 'WAITING' },
        ],
      },
    },
  });

  const job2 = await prisma.job.create({
    data: {
      jobNumber: 'JOB-2026-1002',
      title: 'White Marble Bathroom Vanity',
      clientName: 'Sarah Lee',
      clientPhone: '+60177889900',
      material: 'Carrara Marble',
      color: 'White with grey veins',
      measurements: '1200mm x 500mm x 18mm',
      deadline: new Date('2026-06-05'),
      priority: 'NORMAL',
      status: 'PENDING',
      totalSteps: 5,
      completedSteps: 0,
      workflowSteps: {
        create: [
          { stepNumber: 1, name: 'Cutting', description: 'Cut to specifications', assignedUserId: users[1].id, status: 'WAITING' },
          { stepNumber: 2, name: 'Polishing', description: 'High-gloss finish', assignedUserId: users[2].id, status: 'WAITING' },
          { stepNumber: 3, name: 'Edge Finishing', description: 'Straight edge', assignedUserId: users[3].id, status: 'WAITING' },
          { stepNumber: 4, name: 'QC Inspection', assignedUserId: users[5].id, status: 'WAITING' },
          { stepNumber: 5, name: 'Installation', assignedUserId: users[4].id, status: 'WAITING' },
        ],
      },
    },
  });

  // Audit logs
  await prisma.auditLog.createMany({
    data: [
      { jobId: job1.id, eventType: 'JOB_CREATED', description: 'Job #JOB-2026-1001 created for John Smith' },
      { jobId: job1.id, eventType: 'WORKFLOW_STARTED', description: 'Workflow started for job #JOB-2026-1001' },
      { jobId: job1.id, eventType: 'STEP_COMPLETED', description: 'Step "Cutting" completed', userId: users[1].id },
      { jobId: job1.id, eventType: 'STEP_COMPLETED', description: 'Step "Polishing" completed', userId: users[2].id },
      { jobId: job2.id, eventType: 'JOB_CREATED', description: 'Job #JOB-2026-1002 created for Sarah Lee' },
    ],
  });

  console.log(`✅ Created 2 sample jobs`);
  console.log('🎉 Seed complete!');
  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
