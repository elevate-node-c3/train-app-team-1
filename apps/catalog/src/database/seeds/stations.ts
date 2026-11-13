export interface SeedStation {
  id?: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  altSpellings?: string[];
}

export interface SeedCity {
  id?: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  stations: SeedStation[];
}

export interface SeedGovernorate {
  id?: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  cities: SeedCity[];
}

// These existing catalog IDs are also referenced by timetable stops and fares.
export const CATALOG_STATION_IDS = {
  cairo: '00000000-0000-4000-8000-000000000021',
  giza: '00000000-0000-4000-8000-000000000022',
  beniSuef: '00000000-0000-4000-8000-000000000023',
} as const;

/**
 * The array order IS the documented display order of governorates, the same
 * in Arabic and English (sort_order = position + 1). The first twelve follow
 * the design's station picker; the rest are placed after them.
 */
export const governorates: SeedGovernorate[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'cairo',
    nameAr: 'القاهرة',
    nameEn: 'Cairo',
    cities: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        slug: 'cairo',
        nameAr: 'القاهرة',
        nameEn: 'Cairo',
        stations: [
          {
            id: CATALOG_STATION_IDS.cairo,
            slug: 'ramsis',
            nameAr: 'محطة رمسيس',
            nameEn: 'Ramsis Station',
            altSpellings: ['Ramses', 'Ramses Station', 'Cairo Ramses'],
          },
        ],
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    slug: 'giza',
    nameAr: 'الجيزة',
    nameEn: 'Giza',
    cities: [
      {
        id: '00000000-0000-4000-8000-000000000012',
        slug: 'giza',
        nameAr: 'الجيزة',
        nameEn: 'Giza',
        stations: [
          {
            id: CATALOG_STATION_IDS.giza,
            slug: 'giza',
            nameAr: 'الجيزة',
            nameEn: 'Giza',
            altSpellings: ['Giza', 'Giza Station', 'محطة الجيزة'],
          },
        ],
      },
    ],
  },
  {
    slug: 'alexandria',
    nameAr: 'الإسكندرية',
    nameEn: 'Alexandria',
    cities: [
      {
        slug: 'alexandria',
        nameAr: 'الإسكندرية',
        nameEn: 'Alexandria',
        stations: [
          { slug: 'sidi-gaber', nameAr: 'سيدي جابر', nameEn: 'Sidi Gaber' },
          { slug: 'el-raml', nameAr: 'محطة الرمل', nameEn: 'El Raml Station' },
        ],
      },
    ],
  },
  {
    slug: 'qalyubia',
    nameAr: 'القليوبية',
    nameEn: 'Qalyubia',
    cities: [
      {
        slug: 'banha',
        nameAr: 'بنها',
        nameEn: 'Banha',
        stations: [
          {
            slug: 'banha',
            nameAr: 'بنها',
            nameEn: 'Banha',
            altSpellings: ['Benha'],
          },
        ],
      },
    ],
  },
  {
    slug: 'monufia',
    nameAr: 'المنوفية',
    nameEn: 'Monufia',
    cities: [
      {
        slug: 'shibin-el-kom',
        nameAr: 'شبين الكوم',
        nameEn: 'Shibin El Kom',
        stations: [
          {
            slug: 'shibin-el-kom',
            nameAr: 'شبين الكوم',
            nameEn: 'Shibin El Kom',
            altSpellings: ['Shebin El Kom'],
          },
        ],
      },
    ],
  },
  {
    slug: 'beheira',
    nameAr: 'البحيرة',
    nameEn: 'Beheira',
    cities: [
      {
        slug: 'damanhour',
        nameAr: 'دمنهور',
        nameEn: 'Damanhour',
        stations: [
          { slug: 'damanhour', nameAr: 'دمنهور', nameEn: 'Damanhour' },
        ],
      },
    ],
  },
  {
    slug: 'kafr-el-sheikh',
    nameAr: 'كفر الشيخ',
    nameEn: 'Kafr El Sheikh',
    cities: [
      {
        slug: 'kafr-el-sheikh',
        nameAr: 'كفر الشيخ',
        nameEn: 'Kafr El Sheikh',
        stations: [
          {
            slug: 'kafr-el-sheikh',
            nameAr: 'كفر الشيخ',
            nameEn: 'Kafr El Sheikh',
          },
        ],
      },
    ],
  },
  {
    slug: 'dakahlia',
    nameAr: 'الدقهلية',
    nameEn: 'Dakahlia',
    cities: [
      {
        slug: 'mansoura',
        nameAr: 'المنصورة',
        nameEn: 'Mansoura',
        stations: [
          { slug: 'mansoura', nameAr: 'المنصورة', nameEn: 'Mansoura' },
        ],
      },
    ],
  },
  {
    slug: 'sharqia',
    nameAr: 'الشرقية',
    nameEn: 'Sharqia',
    cities: [
      {
        slug: 'zagazig',
        nameAr: 'الزقازيق',
        nameEn: 'Zagazig',
        stations: [{ slug: 'zagazig', nameAr: 'الزقازيق', nameEn: 'Zagazig' }],
      },
    ],
  },
  {
    slug: 'gharbia',
    nameAr: 'الغربية',
    nameEn: 'Gharbia',
    cities: [
      {
        slug: 'tanta',
        nameAr: 'طنطا',
        nameEn: 'Tanta',
        stations: [{ slug: 'tanta', nameAr: 'طنطا', nameEn: 'Tanta' }],
      },
      {
        slug: 'kafr-el-zayat',
        nameAr: 'كفر الزيات',
        nameEn: 'Kafr El Zayat',
        stations: [
          {
            slug: 'kafr-el-zayat',
            nameAr: 'كفر الزيات',
            nameEn: 'Kafr El Zayat',
          },
        ],
      },
    ],
  },
  {
    slug: 'ismailia',
    nameAr: 'الإسماعيلية',
    nameEn: 'Ismailia',
    cities: [
      {
        slug: 'ismailia',
        nameAr: 'الإسماعيلية',
        nameEn: 'Ismailia',
        stations: [
          { slug: 'ismailia', nameAr: 'الإسماعيلية', nameEn: 'Ismailia' },
        ],
      },
    ],
  },
  {
    slug: 'damietta',
    nameAr: 'دمياط',
    nameEn: 'Damietta',
    cities: [
      {
        slug: 'damietta',
        nameAr: 'دمياط',
        nameEn: 'Damietta',
        stations: [{ slug: 'damietta', nameAr: 'دمياط', nameEn: 'Damietta' }],
      },
    ],
  },
  {
    slug: 'port-said',
    nameAr: 'بورسعيد',
    nameEn: 'Port Said',
    cities: [
      {
        slug: 'port-said',
        nameAr: 'بورسعيد',
        nameEn: 'Port Said',
        stations: [
          { slug: 'port-said', nameAr: 'بورسعيد', nameEn: 'Port Said' },
        ],
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    slug: 'beni-suef',
    nameAr: 'بني سويف',
    nameEn: 'Beni Suef',
    cities: [
      {
        id: '00000000-0000-4000-8000-000000000013',
        slug: 'beni-suef',
        nameAr: 'بني سويف',
        nameEn: 'Beni Suef',
        stations: [
          {
            id: CATALOG_STATION_IDS.beniSuef,
            slug: 'beni-suef',
            nameAr: 'بني سويف',
            nameEn: 'Beni Suef',
            altSpellings: ['Beni Suef', 'Beni Suef Station', 'محطة بني سويف'],
          },
        ],
      },
    ],
  },
  {
    slug: 'minya',
    nameAr: 'المنيا',
    nameEn: 'Minya',
    cities: [
      {
        slug: 'minya',
        nameAr: 'المنيا',
        nameEn: 'Minya',
        stations: [{ slug: 'minya', nameAr: 'المنيا', nameEn: 'Minya' }],
      },
    ],
  },
  {
    slug: 'assiut',
    nameAr: 'أسيوط',
    nameEn: 'Assiut',
    cities: [
      {
        slug: 'assiut',
        nameAr: 'أسيوط',
        nameEn: 'Assiut',
        stations: [
          {
            slug: 'assiut',
            nameAr: 'أسيوط',
            nameEn: 'Assiut',
            altSpellings: ['Asyut'],
          },
        ],
      },
    ],
  },
  {
    slug: 'sohag',
    nameAr: 'سوهاج',
    nameEn: 'Sohag',
    cities: [
      {
        slug: 'sohag',
        nameAr: 'سوهاج',
        nameEn: 'Sohag',
        stations: [{ slug: 'sohag', nameAr: 'سوهاج', nameEn: 'Sohag' }],
      },
    ],
  },
  {
    slug: 'qena',
    nameAr: 'قنا',
    nameEn: 'Qena',
    cities: [
      {
        slug: 'qena',
        nameAr: 'قنا',
        nameEn: 'Qena',
        stations: [{ slug: 'qena', nameAr: 'قنا', nameEn: 'Qena' }],
      },
    ],
  },
  {
    slug: 'luxor',
    nameAr: 'الأقصر',
    nameEn: 'Luxor',
    cities: [
      {
        slug: 'luxor',
        nameAr: 'الأقصر',
        nameEn: 'Luxor',
        stations: [{ slug: 'luxor', nameAr: 'الأقصر', nameEn: 'Luxor' }],
      },
    ],
  },
  {
    slug: 'aswan',
    nameAr: 'أسوان',
    nameEn: 'Aswan',
    cities: [
      {
        slug: 'aswan',
        nameAr: 'أسوان',
        nameEn: 'Aswan',
        stations: [{ slug: 'aswan', nameAr: 'أسوان', nameEn: 'Aswan' }],
      },
    ],
  },
];
