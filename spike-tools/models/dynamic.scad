$fn=64;
linear_extrude(height=30, twist=$t*360, slices=60) translate([6,0]) circle(5);
difference(){ cylinder(r=14,h=5); translate([0,0,-1]) cylinder(r=8+4*sin($t*360),h=8); }
