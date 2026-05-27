/**
 * apollo-enums.js — Valores fijos de la taxonomia de Apollo
 * Para Predictable.ai ICP Builder
 */
(function (global) {
  'use strict';

  global.APOLLO_ENUMS = {

    // SENIORITIES (person_seniorities[])
    seniorities: [
      { value: 'owner',     label: 'Owner' },
      { value: 'founder',   label: 'Founder' },
      { value: 'c_suite',   label: 'C-Suite' },
      { value: 'partner',   label: 'Partner' },
      { value: 'vp',        label: 'VP' },
      { value: 'head',      label: 'Head' },
      { value: 'director',  label: 'Director' },
      { value: 'manager',   label: 'Manager' },
      { value: 'senior',    label: 'Senior' },
      { value: 'entry',     label: 'Entry / IC' },
      { value: 'intern',    label: 'Intern' }
    ],

    // DEPARTMENTS (person_departments[])
    departments: [
      { value: 'sales',                   label: 'Sales' },
      { value: 'marketing',               label: 'Marketing' },
      { value: 'business_development',    label: 'Business Development' },
      { value: 'customer_success',        label: 'Customer Success' },
      { value: 'engineering',             label: 'Engineering' },
      { value: 'product_management',      label: 'Product' },
      { value: 'design',                  label: 'Design' },
      { value: 'data',                    label: 'Data' },
      { value: 'information_technology',  label: 'IT' },
      { value: 'operations',              label: 'Operations' },
      { value: 'finance',                 label: 'Finance' },
      { value: 'accounting',              label: 'Accounting' },
      { value: 'human_resources',         label: 'Human Resources' },
      { value: 'legal',                   label: 'Legal' },
      { value: 'consulting',              label: 'Consulting' },
      { value: 'research',                label: 'Research' },
      { value: 'support',                 label: 'Support' },
      { value: 'administrative',          label: 'Administrative' },
      { value: 'medical_health',          label: 'Medical & Health' },
      { value: 'education',               label: 'Education' },
      { value: 'real_estate',             label: 'Real Estate' },
      { value: 'arts_and_design',         label: 'Arts & Design' },
      { value: 'media_and_communication', label: 'Media & Communication' },
      { value: 'purchasing',              label: 'Purchasing' },
      { value: 'quality_assurance',       label: 'QA' },
      { value: 'program_management',      label: 'Program Management' },
      { value: 'healthcare_services',     label: 'Healthcare Services' },
      { value: 'military',                label: 'Military' },
      { value: 'entrepreneurship',        label: 'Entrepreneurship' }
    ],

    // EMPLOYEE RANGES (organization_num_employees_ranges[])
    employee_ranges: [
      { value: '1,10',        label: '1-10' },
      { value: '11,20',       label: '11-20' },
      { value: '21,50',       label: '21-50' },
      { value: '51,100',      label: '51-100' },
      { value: '101,200',     label: '101-200' },
      { value: '201,500',     label: '201-500' },
      { value: '501,1000',    label: '501-1k' },
      { value: '1001,2000',   label: '1k-2k' },
      { value: '2001,5000',   label: '2k-5k' },
      { value: '5001,10000',  label: '5k-10k' },
      { value: '10001+',      label: '10k+' }
    ],

    // FUNDING STAGES
    funding_stages: [
      { value: 'seed',                 label: 'Seed' },
      { value: 'series_a',             label: 'Series A' },
      { value: 'series_b',             label: 'Series B' },
      { value: 'series_c',             label: 'Series C' },
      { value: 'series_d',             label: 'Series D' },
      { value: 'series_e',             label: 'Series E' },
      { value: 'series_f',             label: 'Series F' },
      { value: 'series_g_h_plus',      label: 'Series G+' },
      { value: 'venture_round',        label: 'Venture' },
      { value: 'debt_financing',       label: 'Debt' },
      { value: 'angel',                label: 'Angel' },
      { value: 'private_equity',       label: 'Private Equity' },
      { value: 'post_ipo_equity',      label: 'Post-IPO' },
      { value: 'unknown',              label: 'Desconocido' }
    ],

    // INDUSTRIES (organization industry tags - top ~80 mas comunes)
    industries: [
      // Tech
      { value: 'information technology & services',  label: 'IT & Services',                       group: 'Tech' },
      { value: 'computer software',                  label: 'Computer Software',                   group: 'Tech' },
      { value: 'internet',                           label: 'Internet',                            group: 'Tech' },
      { value: 'computer & network security',        label: 'Cyber Security',                      group: 'Tech' },
      { value: 'computer hardware',                  label: 'Computer Hardware',                   group: 'Tech' },
      { value: 'telecommunications',                 label: 'Telecommunications',                  group: 'Tech' },
      { value: 'semiconductors',                     label: 'Semiconductors',                      group: 'Tech' },
      { value: 'wireless',                           label: 'Wireless',                            group: 'Tech' },

      // Finance
      { value: 'financial services',                 label: 'Financial Services',                  group: 'Finance' },
      { value: 'banking',                            label: 'Banking',                             group: 'Finance' },
      { value: 'insurance',                          label: 'Insurance',                           group: 'Finance' },
      { value: 'investment management',              label: 'Investment Management',               group: 'Finance' },
      { value: 'venture capital & private equity',   label: 'VC & PE',                             group: 'Finance' },
      { value: 'capital markets',                    label: 'Capital Markets',                     group: 'Finance' },
      { value: 'accounting',                         label: 'Accounting',                          group: 'Finance' },

      // Media / Marketing
      { value: 'marketing & advertising',            label: 'Marketing & Advertising',             group: 'Media' },
      { value: 'public relations & communications',  label: 'PR & Comms',                          group: 'Media' },
      { value: 'media production',                   label: 'Media Production',                    group: 'Media' },
      { value: 'online media',                       label: 'Online Media',                        group: 'Media' },
      { value: 'publishing',                         label: 'Publishing',                          group: 'Media' },
      { value: 'graphic design',                     label: 'Graphic Design',                      group: 'Media' },
      { value: 'design',                             label: 'Design',                              group: 'Media' },
      { value: 'entertainment',                      label: 'Entertainment',                       group: 'Media' },

      // Health
      { value: 'hospital & health care',             label: 'Hospital & Healthcare',               group: 'Health' },
      { value: 'medical devices',                    label: 'Medical Devices',                     group: 'Health' },
      { value: 'pharmaceuticals',                    label: 'Pharmaceuticals',                     group: 'Health' },
      { value: 'biotechnology',                      label: 'Biotech',                             group: 'Health' },
      { value: 'mental health care',                 label: 'Mental Health',                       group: 'Health' },
      { value: 'health, wellness & fitness',         label: 'Wellness & Fitness',                  group: 'Health' },
      { value: 'medical practice',                   label: 'Medical Practice',                    group: 'Health' },

      // Education
      { value: 'higher education',                   label: 'Higher Education',                    group: 'Education' },
      { value: 'education management',               label: 'Education Management',                group: 'Education' },
      { value: 'e-learning',                         label: 'E-Learning',                          group: 'Education' },
      { value: 'professional training & coaching',   label: 'Training & Coaching',                 group: 'Education' },

      // Retail
      { value: 'retail',                             label: 'Retail',                              group: 'Retail' },
      { value: 'apparel & fashion',                  label: 'Apparel & Fashion',                   group: 'Retail' },
      { value: 'luxury goods & jewelry',             label: 'Luxury Goods',                        group: 'Retail' },
      { value: 'cosmetics',                          label: 'Cosmetics',                           group: 'Retail' },
      { value: 'food & beverages',                   label: 'Food & Beverages',                    group: 'Retail' },
      { value: 'consumer goods',                     label: 'Consumer Goods',                      group: 'Retail' },
      { value: 'consumer electronics',               label: 'Consumer Electronics',                group: 'Retail' },

      // Real Estate / Construction
      { value: 'real estate',                        label: 'Real Estate',                         group: 'RealEstate' },
      { value: 'construction',                       label: 'Construction',                        group: 'RealEstate' },
      { value: 'architecture & planning',            label: 'Architecture',                        group: 'RealEstate' },
      { value: 'civil engineering',                  label: 'Civil Engineering',                   group: 'RealEstate' },

      // Manufacturing
      { value: 'automotive',                         label: 'Automotive',                          group: 'Manufacturing' },
      { value: 'aviation & aerospace',               label: 'Aviation & Aerospace',                group: 'Manufacturing' },
      { value: 'machinery',                          label: 'Machinery',                           group: 'Manufacturing' },
      { value: 'industrial automation',              label: 'Industrial Automation',               group: 'Manufacturing' },
      { value: 'mechanical or industrial engineering', label: 'Mech/Industrial Eng',               group: 'Manufacturing' },
      { value: 'chemicals',                          label: 'Chemicals',                           group: 'Manufacturing' },

      // Services
      { value: 'management consulting',              label: 'Management Consulting',               group: 'Services' },
      { value: 'human resources',                    label: 'Human Resources',                     group: 'Services' },
      { value: 'staffing & recruiting',              label: 'Staffing & Recruiting',               group: 'Services' },
      { value: 'legal services',                     label: 'Legal Services',                      group: 'Services' },
      { value: 'outsourcing/offshoring',             label: 'Outsourcing',                         group: 'Services' },

      // Logistics / Travel
      { value: 'logistics & supply chain',           label: 'Logistics & Supply Chain',            group: 'Logistics' },
      { value: 'transportation/trucking/railroad',   label: 'Transportation',                      group: 'Logistics' },
      { value: 'airlines/aviation',                  label: 'Airlines',                            group: 'Logistics' },
      { value: 'leisure, travel & tourism',          label: 'Travel & Tourism',                    group: 'Logistics' },
      { value: 'hospitality',                        label: 'Hospitality',                         group: 'Logistics' },
      { value: 'restaurants',                        label: 'Restaurants',                         group: 'Logistics' },

      // Energy
      { value: 'oil & energy',                       label: 'Oil & Energy',                        group: 'Energy' },
      { value: 'renewables & environment',           label: 'Renewables',                          group: 'Energy' },
      { value: 'utilities',                          label: 'Utilities',                           group: 'Energy' },

      // Public sector
      { value: 'government administration',          label: 'Government',                          group: 'PublicSector' },
      { value: 'nonprofit organization management',  label: 'Nonprofit',                           group: 'PublicSector' }
    ],

    // EMAIL STATUS
    email_statuses: [
      { value: 'verified',         label: 'Verified' },
      { value: 'likely_to_engage', label: 'Likely to engage' },
      { value: 'guessed',          label: 'Guessed' },
      { value: 'unavailable',      label: 'Unavailable' }
    ],

    // QUICK COUNTRIES (top 25 B2B)
    countries: [
      { value: 'United States',      label: 'United States' },
      { value: 'Mexico',              label: 'Mexico' },
      { value: 'Colombia',            label: 'Colombia' },
      { value: 'Argentina',           label: 'Argentina' },
      { value: 'Chile',               label: 'Chile' },
      { value: 'Peru',                label: 'Peru' },
      { value: 'Brazil',              label: 'Brasil' },
      { value: 'Spain',               label: 'Spain' },
      { value: 'United Kingdom',      label: 'UK' },
      { value: 'Canada',              label: 'Canada' },
      { value: 'Germany',             label: 'Germany' },
      { value: 'France',              label: 'France' },
      { value: 'Italy',               label: 'Italy' },
      { value: 'Netherlands',         label: 'Netherlands' },
      { value: 'Portugal',            label: 'Portugal' },
      { value: 'Australia',           label: 'Australia' },
      { value: 'Israel',              label: 'Israel' },
      { value: 'India',               label: 'India' },
      { value: 'Singapore',           label: 'Singapore' },
      { value: 'Uruguay',             label: 'Uruguay' },
      { value: 'Costa Rica',          label: 'Costa Rica' },
      { value: 'Panama',              label: 'Panama' },
      { value: 'Ecuador',             label: 'Ecuador' },
      { value: 'Dominican Republic',  label: 'Rep. Dominicana' },
      { value: 'Guatemala',           label: 'Guatemala' }
    ]
  };

  console.log('[apollo-enums] cargados',
    Object.entries(global.APOLLO_ENUMS).map(([k,v]) => k+'('+v.length+')').join(', '));
})(window);
