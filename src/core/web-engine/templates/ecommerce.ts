// KCode - Web Engine: E-commerce Store Template
//
// Complete Next.js + React + Tailwind e-commerce storefront.
// All components are fully machine-generated (needsLlm: false).

import type { FileTemplate } from "../templates";

const PRODUCTS = [
  {
    id: 1,
    name: "Wireless Noise-Cancelling Headphones",
    price: 299.99,
    rating: 5,
    category: "Electronics",
    color: "from-violet-500 to-purple-600",
  },
  {
    id: 2,
    name: "Slim Leather Wallet",
    price: 49.99,
    rating: 4,
    category: "Clothing",
    color: "from-amber-500 to-orange-600",
  },
  {
    id: 3,
    name: "Smart Home Speaker",
    price: 129.99,
    rating: 4,
    category: "Electronics",
    color: "from-cyan-500 to-blue-600",
  },
  {
    id: 4,
    name: "Organic Cotton T-Shirt",
    price: 34.99,
    rating: 5,
    category: "Clothing",
    color: "from-emerald-500 to-green-600",
  },
  {
    id: 5,
    name: "Ceramic Pour-Over Set",
    price: 64.99,
    rating: 5,
    category: "Home",
    color: "from-rose-500 to-pink-600",
  },
  {
    id: 6,
    name: "Running Shoes Pro",
    price: 159.99,
    rating: 4,
    category: "Sports",
    color: "from-sky-500 to-indigo-600",
  },
  {
    id: 7,
    name: "The Art of Programming",
    price: 29.99,
    rating: 5,
    category: "Books",
    color: "from-yellow-500 to-amber-600",
  },
  {
    id: 8,
    name: "Bamboo Desk Organizer",
    price: 39.99,
    rating: 4,
    category: "Home",
    color: "from-teal-500 to-emerald-600",
  },
  {
    id: 9,
    name: "USB-C Charging Hub",
    price: 79.99,
    rating: 4,
    category: "Electronics",
    color: "from-fuchsia-500 to-purple-600",
  },
  {
    id: 10,
    name: "Yoga Mat Premium",
    price: 89.99,
    rating: 5,
    category: "Sports",
    color: "from-lime-500 to-green-600",
  },
  {
    id: 11,
    name: "Mindful Living Guide",
    price: 24.99,
    rating: 4,
    category: "Books",
    color: "from-orange-500 to-red-600",
  },
  {
    id: 12,
    name: "Merino Wool Sweater",
    price: 119.99,
    rating: 5,
    category: "Clothing",
    color: "from-indigo-500 to-violet-600",
  },
];

function productsToTS(): string {
  const lines = PRODUCTS.map(
    (p) =>
      `  { id: ${p.id}, name: ${JSON.stringify(p.name)}, price: ${p.price}, rating: ${p.rating}, category: ${JSON.stringify(p.category)}, gradient: ${JSON.stringify(p.color)} },`,
  );
  return `[\n${lines.join("\n")}\n]`;
}

export function ecommerceComponents(): FileTemplate[] {
  return [
    // ── Root Layout ─────────────────────────────────────────────
    {
      path: "src/app/layout.tsx",
      content: `"use client";
import { useState, createContext, useContext, type ReactNode } from "react";
import "./globals.css";

export interface CartItem {
  id: number;
  name: string;
  price: number;
  gradient: string;
  quantity: number;
}

interface CartContextValue {
  items: CartItem[];
  addItem: (product: { id: number; name: string; price: number; gradient: string }) => void;
  removeItem: (id: number) => void;
  updateQuantity: (id: number, quantity: number) => void;
  cartOpen: boolean;
  setCartOpen: (open: boolean) => void;
  totalItems: number;
  subtotal: number;
}

export const CartContext = createContext<CartContextValue>({
  items: [],
  addItem: () => {},
  removeItem: () => {},
  updateQuantity: () => {},
  cartOpen: false,
  setCartOpen: () => {},
  totalItems: 0,
  subtotal: 0,
});

export const useCart = () => useContext(CartContext);

export default function RootLayout({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);

  const addItem = (product: { id: number; name: string; price: number; gradient: string }) => {
    setItems(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) {
        return prev.map(i => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
    setCartOpen(true);
  };

  const removeItem = (id: number) => {
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const updateQuantity = (id: number, quantity: number) => {
    if (quantity <= 0) {
      removeItem(id);
      return;
    }
    setItems(prev => prev.map(i => i.id === id ? { ...i, quantity } : i));
  };

  const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  return (
    <html lang="en">
      <body className="antialiased bg-white text-gray-900 min-h-screen">
        <CartContext.Provider value={{ items, addItem, removeItem, updateQuantity, cartOpen, setCartOpen, totalItems, subtotal }}>
          {children}
        </CartContext.Provider>
      </body>
    </html>
  );
}
`,
      needsLlm: false,
    },
    // ── Global CSS ──────────────────────────────────────────────
    {
      path: "src/app/globals.css",
      content: `@import "tailwindcss";

@layer base {
  :root {
    --accent: 99 102 241;
  }
}

@layer utilities {
  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
}
`,
      needsLlm: false,
    },
    // ── Store Homepage ──────────────────────────────────────────
    {
      path: "src/app/page.tsx",
      content: `"use client";
import Header from "@/components/Header";
import FeaturedBanner from "@/components/FeaturedBanner";
import CategoryNav from "@/components/CategoryNav";
import ProductGrid from "@/components/ProductGrid";
import ProductFilters from "@/components/ProductFilters";
import CartDrawer from "@/components/CartDrawer";
import { useState } from "react";

export default function Home() {
  const [activeCategory, setActiveCategory] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("featured");
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 500]);
  const [minRating, setMinRating] = useState(0);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header searchQuery={searchQuery} onSearchChange={setSearchQuery} />
      <FeaturedBanner />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <CategoryNav active={activeCategory} onChange={setActiveCategory} />
        <div className="mt-8 flex flex-col lg:flex-row gap-8">
          <ProductFilters
            sortBy={sortBy}
            onSortChange={setSortBy}
            priceRange={priceRange}
            onPriceRangeChange={setPriceRange}
            minRating={minRating}
            onMinRatingChange={setMinRating}
          />
          <div className="flex-1">
            <ProductGrid
              activeCategory={activeCategory}
              searchQuery={searchQuery}
              sortBy={sortBy}
              priceRange={priceRange}
              minRating={minRating}
            />
          </div>
        </div>
      </main>
      <CartDrawer />
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── Header ──────────────────────────────────────────────────
    {
      path: "src/components/Header.tsx",
      content: `"use client";
import { ShoppingCart, User, Menu } from "lucide-react";
import { useCart } from "@/app/layout";
import SearchBar from "./SearchBar";
import { useState } from "react";

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export default function Header({ searchQuery, onSearchChange }: HeaderProps) {
  const { setCartOpen, totalItems } = useCart();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden p-2 rounded-md hover:bg-gray-100"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              <Menu className="w-5 h-5" />
            </button>
            <a href="/" className="text-xl font-bold text-indigo-600">
              ShopKCode
            </a>
          </div>

          {/* Search */}
          <div className="hidden md:block flex-1 max-w-lg mx-8">
            <SearchBar value={searchQuery} onChange={onSearchChange} />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4">
            <button className="p-2 rounded-full hover:bg-gray-100 transition">
              <User className="w-5 h-5 text-gray-600" />
            </button>
            <button
              className="relative p-2 rounded-full hover:bg-gray-100 transition"
              onClick={() => setCartOpen(true)}
            >
              <ShoppingCart className="w-5 h-5 text-gray-600" />
              {totalItems > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-indigo-600 text-white text-xs font-bold rounded-full flex items-center justify-center">
                  {totalItems}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Mobile search */}
        <div className="md:hidden pb-3">
          <SearchBar value={searchQuery} onChange={onSearchChange} />
        </div>
      </div>
    </header>
  );
}
`,
      needsLlm: false,
    },
    // ── SearchBar ───────────────────────────────────────────────
    {
      path: "src/components/SearchBar.tsx",
      content: `"use client";
import { Search } from "lucide-react";
import { useState, useRef, useEffect } from "react";

const SUGGESTIONS = [
  "Wireless Headphones",
  "Cotton T-Shirt",
  "Running Shoes",
  "Smart Speaker",
  "Yoga Mat",
  "Desk Organizer",
  "Leather Wallet",
  "Wool Sweater",
  "Charging Hub",
  "Pour-Over Set",
];

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
}

export default function SearchBar({ value, onChange }: SearchBarProps) {
  const [focused, setFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = value.length > 0
    ? SUGGESTIONS.filter(s => s.toLowerCase().includes(value.toLowerCase()))
    : [];

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={wrapperRef} className="relative w-full">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search products..."
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          className="w-full pl-10 pr-4 py-2 bg-gray-100 border border-transparent rounded-full text-sm focus:outline-none focus:border-indigo-500 focus:bg-white transition"
        />
      </div>

      {focused && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-50">
          {filtered.map((s, i) => (
            <button
              key={i}
              className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-2 transition"
              onClick={() => { onChange(s); setFocused(false); }}
            >
              <Search className="w-3 h-3 text-gray-400" />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── FeaturedBanner ──────────────────────────────────────────
    {
      path: "src/components/FeaturedBanner.tsx",
      content: `export default function FeaturedBanner() {
  return (
    <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="text-white text-center md:text-left">
            <p className="text-sm font-medium uppercase tracking-wider text-indigo-200">
              Limited Time Offer
            </p>
            <h2 className="mt-2 text-3xl md:text-4xl font-bold">
              Spring Collection Sale
            </h2>
            <p className="mt-2 text-indigo-100 max-w-md">
              Up to 40% off on selected items. Free shipping on orders over $99.
            </p>
          </div>
          <button className="px-8 py-3 bg-white text-indigo-600 font-semibold rounded-full hover:bg-gray-100 transition shadow-lg">
            Shop Now
          </button>
        </div>
      </div>
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── CategoryNav ─────────────────────────────────────────────
    {
      path: "src/components/CategoryNav.tsx",
      content: `"use client";

const CATEGORIES = ["All", "Electronics", "Clothing", "Home", "Sports", "Books"];

interface CategoryNavProps {
  active: string;
  onChange: (cat: string) => void;
}

export default function CategoryNav({ active, onChange }: CategoryNavProps) {
  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide py-1">
      {CATEGORIES.map(cat => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={\`px-5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all \${
            active === cat
              ? "bg-indigo-600 text-white shadow-md shadow-indigo-200"
              : "bg-white text-gray-600 border border-gray-200 hover:border-indigo-300 hover:text-indigo-600"
          }\`}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── ProductFilters ──────────────────────────────────────────
    {
      path: "src/components/ProductFilters.tsx",
      content: `"use client";
import { useState } from "react";
import { Settings } from "lucide-react";

interface ProductFiltersProps {
  sortBy: string;
  onSortChange: (v: string) => void;
  priceRange: [number, number];
  onPriceRangeChange: (v: [number, number]) => void;
  minRating: number;
  onMinRatingChange: (v: number) => void;
}

export default function ProductFilters({
  sortBy,
  onSortChange,
  priceRange,
  onPriceRangeChange,
  minRating,
  onMinRatingChange,
}: ProductFiltersProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="lg:hidden flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium"
        onClick={() => setOpen(!open)}
      >
        <Settings className="w-4 h-4" />
        Filters
      </button>

      <aside className={\`w-full lg:w-56 shrink-0 space-y-6 \${open ? "block" : "hidden lg:block"}\`}>
        {/* Sort */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Sort By</h3>
          <select
            value={sortBy}
            onChange={e => onSortChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-500"
          >
            <option value="featured">Featured</option>
            <option value="price-asc">Price: Low to High</option>
            <option value="price-desc">Price: High to Low</option>
            <option value="rating">Highest Rated</option>
          </select>
        </div>

        {/* Price Range */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Price Range</h3>
          <div className="space-y-2">
            <input
              type="range"
              min={0}
              max={500}
              value={priceRange[1]}
              onChange={e => onPriceRangeChange([priceRange[0], Number(e.target.value)])}
              className="w-full accent-indigo-600"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>\${priceRange[0]}</span>
              <span>\${priceRange[1]}</span>
            </div>
          </div>
        </div>

        {/* Rating Filter */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Minimum Rating</h3>
          <div className="space-y-1">
            {[4, 3, 2, 1, 0].map(r => (
              <button
                key={r}
                onClick={() => onMinRatingChange(r)}
                className={\`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition \${
                  minRating === r ? "bg-indigo-50 text-indigo-700" : "hover:bg-gray-50"
                }\`}
              >
                <span className="flex">
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} className={\`text-sm \${i < r ? "text-yellow-400" : "text-gray-300"}\`}>
                      \\u2605
                    </span>
                  ))}
                </span>
                {r > 0 ? <span>& up</span> : <span>All</span>}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
`,
      needsLlm: false,
    },
    // ── ProductGrid ─────────────────────────────────────────────
    {
      path: "src/components/ProductGrid.tsx",
      content: `"use client";
import ProductCard from "./ProductCard";

const products = ${productsToTS()};

interface ProductGridProps {
  activeCategory: string;
  searchQuery: string;
  sortBy: string;
  priceRange: [number, number];
  minRating: number;
}

export default function ProductGrid({
  activeCategory,
  searchQuery,
  sortBy,
  priceRange,
  minRating,
}: ProductGridProps) {
  let filtered = products.filter(p => {
    if (activeCategory !== "All" && p.category !== activeCategory) return false;
    if (searchQuery && !p.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (p.price < priceRange[0] || p.price > priceRange[1]) return false;
    if (p.rating < minRating) return false;
    return true;
  });

  if (sortBy === "price-asc") filtered.sort((a, b) => a.price - b.price);
  else if (sortBy === "price-desc") filtered.sort((a, b) => b.price - a.price);
  else if (sortBy === "rating") filtered.sort((a, b) => b.rating - a.rating);

  if (filtered.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-gray-500 text-lg">No products found matching your criteria.</p>
        <p className="text-gray-400 text-sm mt-1">Try adjusting your filters or search query.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {filtered.map(product => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
`,
      needsLlm: false,
    },
    // ── ProductCard ─────────────────────────────────────────────
    {
      path: "src/components/ProductCard.tsx",
      content: `"use client";
import { ShoppingCart, Heart } from "lucide-react";
import { useCart } from "@/app/layout";
import { useState } from "react";

interface Product {
  id: number;
  name: string;
  price: number;
  rating: number;
  category: string;
  gradient: string;
}

export default function ProductCard({ product }: { product: Product }) {
  const { addItem } = useCart();
  const [liked, setLiked] = useState(false);
  const [quickView, setQuickView] = useState(false);

  return (
    <>
      <div className="group bg-white rounded-2xl border border-gray-200 overflow-hidden hover:shadow-lg hover:shadow-indigo-100/50 hover:-translate-y-1 transition-all duration-300">
        {/* Image placeholder */}
        <div
          className="relative h-52 cursor-pointer"
          onClick={() => setQuickView(true)}
        >
          <div className={\`absolute inset-0 bg-gradient-to-br \${product.gradient} opacity-80\`} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-white/80 text-sm font-medium tracking-wide uppercase">
              {product.category}
            </span>
          </div>
          <button
            className={\`absolute top-3 right-3 p-2 rounded-full bg-white/90 shadow-sm hover:bg-white transition \${liked ? "text-red-500" : "text-gray-400"}\`}
            onClick={e => { e.stopPropagation(); setLiked(!liked); }}
          >
            <Heart className="w-4 h-4" fill={liked ? "currentColor" : "none"} />
          </button>
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity text-white text-sm font-medium bg-black/50 px-4 py-2 rounded-full">
              Quick View
            </span>
          </div>
        </div>

        {/* Info */}
        <div className="p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide">{product.category}</p>
          <h3 className="mt-1 font-semibold text-gray-900 line-clamp-1">{product.name}</h3>

          {/* Rating */}
          <div className="flex items-center gap-1 mt-2">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className={\`text-sm \${i < product.rating ? "text-yellow-400" : "text-gray-200"}\`}>
                \\u2605
              </span>
            ))}
            <span className="text-xs text-gray-400 ml-1">({product.rating}.0)</span>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-lg font-bold text-gray-900">
              \${product.price.toFixed(2)}
            </span>
            <button
              onClick={() => addItem(product)}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-full hover:bg-indigo-700 active:scale-95 transition-all"
            >
              <ShoppingCart className="w-4 h-4" />
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Quick View Modal */}
      {quickView && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setQuickView(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className={\`h-56 bg-gradient-to-br \${product.gradient} flex items-center justify-center\`}>
              <span className="text-white/80 text-lg font-medium">{product.name}</span>
            </div>
            <div className="p-6">
              <p className="text-xs text-gray-400 uppercase tracking-wide">{product.category}</p>
              <h3 className="mt-1 text-xl font-bold text-gray-900">{product.name}</h3>
              <div className="flex items-center gap-1 mt-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <span key={i} className={\`text-sm \${i < product.rating ? "text-yellow-400" : "text-gray-200"}\`}>
                    \\u2605
                  </span>
                ))}
              </div>
              <p className="mt-3 text-gray-500 text-sm leading-relaxed">
                Premium quality {product.category.toLowerCase()} product. Carefully crafted with attention to detail and built to last.
              </p>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-2xl font-bold text-gray-900">\${product.price.toFixed(2)}</span>
                <button
                  onClick={() => { addItem(product); setQuickView(false); }}
                  className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-full hover:bg-indigo-700 transition"
                >
                  <ShoppingCart className="w-4 h-4" />
                  Add to Cart
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
`,
      needsLlm: false,
    },
    // ── CartDrawer ──────────────────────────────────────────────
    {
      path: "src/components/CartDrawer.tsx",
      content: `"use client";
import { X, Plus, Minus, ShoppingCart } from "lucide-react";
import { useCart } from "@/app/layout";

export default function CartDrawer() {
  const { items, cartOpen, setCartOpen, removeItem, updateQuantity, subtotal, totalItems } = useCart();

  return (
    <>
      {/* Backdrop */}
      {cartOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity"
          onClick={() => setCartOpen(false)}
        />
      )}

      {/* Drawer */}
      <div
        className={\`fixed top-0 right-0 z-50 h-full w-full max-w-md bg-white shadow-2xl transform transition-transform duration-300 ease-out \${
          cartOpen ? "translate-x-0" : "translate-x-full"
        }\`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-indigo-600" />
            <h2 className="text-lg font-semibold">Cart ({totalItems})</h2>
          </div>
          <button
            onClick={() => setCartOpen(false)}
            className="p-2 rounded-full hover:bg-gray-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ maxHeight: "calc(100vh - 200px)" }}>
          {items.length === 0 ? (
            <div className="text-center py-12">
              <ShoppingCart className="w-12 h-12 text-gray-300 mx-auto" />
              <p className="mt-4 text-gray-500">Your cart is empty</p>
              <button
                onClick={() => setCartOpen(false)}
                className="mt-4 text-indigo-600 text-sm font-medium hover:underline"
              >
                Continue Shopping
              </button>
            </div>
          ) : (
            items.map(item => (
              <div key={item.id} className="flex gap-4 p-3 rounded-xl bg-gray-50">
                {/* Thumbnail */}
                <div className={\`w-16 h-16 rounded-lg bg-gradient-to-br \${item.gradient} shrink-0\`} />

                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-gray-900 truncate">{item.name}</h4>
                  <p className="text-sm font-bold text-gray-900 mt-1">\${item.price.toFixed(2)}</p>

                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={() => updateQuantity(item.id, item.quantity - 1)}
                      className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-100 transition"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <span className="text-sm font-medium w-6 text-center">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(item.id, item.quantity + 1)}
                      className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-100 transition"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => removeItem(item.id)}
                      className="ml-auto text-xs text-red-500 hover:text-red-700 transition"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 border-t border-gray-100 bg-white p-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Subtotal</span>
              <span className="text-xl font-bold text-gray-900">\${subtotal.toFixed(2)}</span>
            </div>
            <button className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-full hover:bg-indigo-700 active:scale-[0.98] transition-all">
              Checkout
            </button>
            <p className="text-xs text-gray-400 text-center">Shipping and taxes calculated at checkout</p>
          </div>
        )}
      </div>
    </>
  );
}
`,
      needsLlm: false,
    },
  ];
}
