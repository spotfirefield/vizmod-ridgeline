"""
Generate examples/city_temperatures.csv for the Joy Plot mod.

Produces a tidy long-format CSV with columns:
    country, city, hemisphere, avg_temp_c, month_num

Each city gets ~4 readings per month × 12 months = 48 rows.
Per-city climate is modelled as:
    T(month) = annual_mean + amplitude * cos(2π * (month - peak_month)/12)
                + N(0, noise_sd)
…with the peak shifted ±6 months for southern-hemisphere cities so January
is hot in Sydney and cold in Oslo.
"""

import csv
import math
import random
from pathlib import Path

random.seed(42)

# (country, hemisphere, [(city, annual_mean_C, amplitude_C, noise_sd), ...])
COUNTRIES = [
    ("UK",            "Northern", [("London", 11, 9, 1.5),  ("Manchester", 10, 8, 1.5),  ("Edinburgh", 9, 7, 1.4),  ("Bristol", 11, 8, 1.4)]),
    ("USA",           "Northern", [("New York", 13, 13, 2.0), ("Chicago", 11, 14, 2.2),   ("Los Angeles", 18, 5, 1.0), ("Miami", 25, 5, 1.0), ("Seattle", 12, 7, 1.4)]),
    ("Canada",        "Northern", [("Toronto", 9, 14, 2.0),   ("Vancouver", 11, 7, 1.4),  ("Montreal", 7, 16, 2.2),   ("Calgary", 5, 14, 2.5)]),
    ("Norway",        "Northern", [("Oslo", 6, 12, 2.0),      ("Bergen", 8, 8, 1.6),      ("Trondheim", 5, 11, 1.8),  ("Stavanger", 8, 8, 1.5)]),
    ("Egypt",         "Northern", [("Cairo", 22, 9, 1.4),     ("Alexandria", 21, 7, 1.2), ("Luxor", 26, 12, 1.5),     ("Aswan", 27, 11, 1.4)]),
    ("India",         "Northern", [("Mumbai", 28, 4, 1.0),    ("Delhi", 26, 11, 1.6),     ("Chennai", 29, 4, 1.0),    ("Bangalore", 24, 4, 1.0), ("Kolkata", 27, 8, 1.4)]),
    ("Singapore",     "Northern", [("Singapore", 28, 1.5, 0.8), ("Jurong", 28, 1.5, 0.8), ("Sentosa", 28, 1.5, 0.8),  ("Woodlands", 28, 1.5, 0.8)]),
    ("Australia",     "Southern", [("Sydney", 18, 7, 1.4),    ("Melbourne", 15, 8, 1.6),  ("Brisbane", 21, 6, 1.2),   ("Perth", 19, 7, 1.4), ("Adelaide", 17, 8, 1.5)]),
    ("Japan",         "Northern", [("Tokyo", 16, 11, 1.6),    ("Osaka", 17, 11, 1.6),     ("Sapporo", 9, 13, 1.8),    ("Fukuoka", 17, 10, 1.5)]),
    ("Mexico",        "Northern", [("Mexico City", 16, 4, 1.0),("Guadalajara", 20, 5, 1.2),("Monterrey", 23, 8, 1.4), ("Cancun", 26, 5, 1.0)]),
    ("Brazil",        "Southern", [("Rio de Janeiro", 23, 4, 1.2),("Sao Paulo", 19, 5, 1.3),("Brasilia", 21, 3, 1.0), ("Manaus", 27, 2, 0.9)]),
    ("Argentina",     "Southern", [("Buenos Aires", 17, 8, 1.5),("Cordoba", 17, 9, 1.6),  ("Mendoza", 16, 10, 1.7),  ("Rosario", 17, 9, 1.6)]),
    ("South Africa",  "Southern", [("Cape Town", 16, 6, 1.3), ("Johannesburg", 16, 6, 1.4),("Durban", 21, 5, 1.2),    ("Pretoria", 17, 6, 1.4)]),
    ("Germany",       "Northern", [("Berlin", 10, 11, 1.7),   ("Munich", 9, 11, 1.7),     ("Hamburg", 10, 9, 1.6),    ("Frankfurt", 11, 11, 1.7)]),
    ("France",        "Northern", [("Paris", 12, 10, 1.6),    ("Marseille", 16, 9, 1.5),  ("Lyon", 13, 11, 1.7),      ("Bordeaux", 14, 10, 1.6)]),
    ("Spain",         "Northern", [("Madrid", 15, 12, 1.7),   ("Barcelona", 17, 9, 1.5),  ("Seville", 19, 10, 1.6),   ("Valencia", 18, 9, 1.5)]),
    ("China",         "Northern", [("Beijing", 13, 15, 2.0),  ("Shanghai", 17, 12, 1.8),  ("Guangzhou", 23, 8, 1.4),  ("Chengdu", 17, 10, 1.6)]),
    ("Russia",        "Northern", [("Moscow", 6, 16, 2.4),    ("Saint Petersburg", 6, 14, 2.2),("Sochi", 14, 9, 1.6), ("Vladivostok", 5, 16, 2.4)]),
    ("Indonesia",     "Southern", [("Jakarta", 27, 1.5, 0.9), ("Surabaya", 28, 2, 0.9),   ("Bandung", 23, 2, 0.9),    ("Medan", 27, 1.5, 0.9)]),
    ("New Zealand",   "Southern", [("Auckland", 16, 5, 1.2),  ("Wellington", 14, 5, 1.2), ("Christchurch", 12, 7, 1.4),("Dunedin", 11, 6, 1.3)]),
]

# Northern peak summer = month 7 (July). Southern shifted by 6 months.
SAMPLES_PER_MONTH = 4

OUT_PATH = Path(__file__).parent / "examples" / "city_temperatures.csv"


def temp_for(month, hemisphere, mean, amp, noise_sd):
    peak = 7 if hemisphere == "Northern" else 1
    seasonal = mean + amp * math.cos(2 * math.pi * (month - peak) / 12)
    return seasonal + random.gauss(0, noise_sd)


def main():
    rows_written = 0
    with OUT_PATH.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["country", "city", "hemisphere", "avg_temp_c", "month_num"])
        for country, hemisphere, cities in COUNTRIES:
            for city, mean, amp, sd in cities:
                for month in range(1, 13):
                    for _ in range(SAMPLES_PER_MONTH):
                        t = temp_for(month, hemisphere, mean, amp, sd)
                        w.writerow([country, city, hemisphere, f"{t:.1f}", month])
                        rows_written += 1
    print(f"Wrote {rows_written} rows across {sum(len(c[2]) for c in COUNTRIES)} cities "
          f"in {len(COUNTRIES)} countries to {OUT_PATH}")


if __name__ == "__main__":
    main()
